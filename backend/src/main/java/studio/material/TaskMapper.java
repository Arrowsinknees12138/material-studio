package studio.material;

import java.time.Instant;
import java.util.List;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

enum TaskStatus { QUEUED, RUNNING, SUCCEEDED, FAILED }
enum TaskStage {
    CHECK_INPUTS("素材检查"), GENERATE("模拟生成"), FINALIZE("结果整理");

    private final String label;

    TaskStage(String label) {
        this.label = label;
    }

    String label() {
        return label;
    }
}

record Task(String id, long ownerId, String templateId, String templateTitle, String requestId,
            TaskStatus status, TaskStage stage, Instant createdAt, Instant completedAt,
            String resultKey, String errorMessage, TaskStage failAt, int checkMs, int generateMs, int finalizeMs) {
    TaskView view() {
        return new TaskView(id, templateId, templateTitle, status, stage, createdAt, completedAt,
                resultKey == null ? null : "/api/tasks/" + id + "/result", errorMessage);
    }

}

record TaskView(String id, String templateId, String templateTitle, TaskStatus status, TaskStage stage,
                Instant createdAt, Instant completedAt, String resultUrl, String errorMessage) {}
record NewTask(String id, long ownerId, String templateId, String requestId, TaskStage failAt,
               int checkMs, int generateMs, int finalizeMs) {}

record WorkItem(String id, String templateId, TaskStage stage, TaskStage failAt,
                int checkMs, int generateMs, int finalizeMs, String generatedSample) {}

@Mapper
interface TaskMapper {
    String SELECT_TASK = """
        SELECT t.id, t.owner_id, t.template_id, p.title AS template_title, t.request_id, t.status, t.stage,
               t.created_at, t.completed_at, t.result_key, t.error_message, t.fail_at,
               t.check_ms, t.generate_ms, t.finalize_ms
        FROM tasks t JOIN templates p ON p.id = t.template_id
        """;

    @Select(SELECT_TASK + " WHERE t.id = #{id} AND t.owner_id = #{ownerId}")
    Task findOwned(String id, long ownerId);

    @Select(SELECT_TASK + " WHERE t.owner_id = #{ownerId} AND t.request_id = #{requestId}")
    Task findByRequest(long ownerId, String requestId);

    @Select(SELECT_TASK + " WHERE t.owner_id = #{ownerId} AND t.request_id = #{requestId} FOR UPDATE OF t")
    Task lockByRequest(long ownerId, String requestId);

    @Select(SELECT_TASK + """
        WHERE t.owner_id = #{ownerId} AND (#{templateId, jdbcType=VARCHAR} IS NULL OR t.template_id = #{templateId})
        ORDER BY t.created_at DESC, t.id DESC
        """)
    List<Task> listOwned(long ownerId, String templateId);

    @Select("<script>" + SELECT_TASK + """
        WHERE t.owner_id = #{ownerId}
        <if test="templateId != null">AND t.template_id = #{templateId}</if>
        <if test="active">AND t.status IN ('QUEUED', 'RUNNING')</if>
        <if test="beforeId != null">
          AND (t.created_at &lt; #{beforeTime} OR (t.created_at = #{beforeTime} AND t.id &lt; #{beforeId}))
        </if>
        ORDER BY t.created_at DESC, t.id DESC LIMIT #{limit}
        </script>
        """)
    List<Task> pageOwned(long ownerId, String templateId, boolean active, Instant beforeTime, String beforeId, int limit);

    @Select("<script>" + SELECT_TASK + """
        WHERE t.owner_id = #{ownerId} AND t.id IN
        <foreach collection="ids" item="id" open="(" separator="," close=")">#{id}</foreach>
        </script>
        """)
    List<Task> findOwnedBatch(long ownerId, List<String> ids);

    @Insert("""
        INSERT INTO tasks (id, owner_id, template_id, request_id, status, fail_at, check_ms, generate_ms, finalize_ms)
        VALUES (#{id}, #{ownerId}, #{templateId}, #{requestId}, 'QUEUED',
                #{failAt, jdbcType=VARCHAR}, #{checkMs}, #{generateMs}, #{finalizeMs})
        ON DUPLICATE KEY UPDATE id = id
        """)
    void insertOrKeep(NewTask task);

    @Insert("INSERT INTO task_assets(task_id, slot_index, asset_id) VALUES (#{taskId}, #{slot}, #{assetId})")
    void link(String taskId, int slot, String assetId);

    @Select("""
        SELECT id, template_id, stage, fail_at, check_ms, generate_ms, finalize_ms, generated_sample
        FROM tasks
        WHERE next_run_at <= CURRENT_TIMESTAMP(3) AND status IN ('QUEUED', 'RUNNING')
        ORDER BY next_run_at, created_at, id
        LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    WorkItem lockNextDue();

    @Update("""
        UPDATE tasks
        SET status = 'RUNNING', stage = #{stage}, generated_sample = #{sample, jdbcType=VARCHAR},
            next_run_at = TIMESTAMPADD(MICROSECOND, #{delayMs} * 1000, CURRENT_TIMESTAMP(3))
        WHERE id = #{id}
        """)
    void schedule(String id, TaskStage stage, int delayMs, String sample);

    @Update("""
        UPDATE tasks SET status = 'SUCCEEDED', result_key = #{key}, completed_at = CURRENT_TIMESTAMP(3),
                         next_run_at = NULL
        WHERE id = #{id}
        """)
    void succeed(String id, String key);

    @Update("""
        UPDATE tasks SET status = 'FAILED', error_message = #{message}, completed_at = CURRENT_TIMESTAMP(3),
                         next_run_at = NULL
        WHERE id = #{id}
        """)
    void fail(String id, String message);
}
