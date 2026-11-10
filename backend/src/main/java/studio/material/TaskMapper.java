package studio.material;

import java.time.Instant;
import java.util.List;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

enum TaskStatus { QUEUED, RUNNING, SUCCEEDED, FAILED }
enum TaskStage { CHECK_INPUTS, GENERATE, FINALIZE }

record Task(String id, long ownerId, String templateId, String templateTitle, String requestId,
            TaskStatus status, TaskStage stage, Instant createdAt, Instant completedAt,
            String resultKey, String errorMessage, TaskStage failAt, int checkMs, int generateMs, int finalizeMs) {
    TaskView view() {
        return new TaskView(id, templateId, templateTitle, status, stage, createdAt, completedAt,
                resultKey == null ? null : "/api/tasks/" + id + "/result", errorMessage);
    }

    int delay(TaskStage currentStage) {
        return switch (currentStage) {
            case CHECK_INPUTS -> checkMs;
            case GENERATE -> generateMs;
            case FINALIZE -> finalizeMs;
        };
    }
}

record TaskView(String id, String templateId, String templateTitle, TaskStatus status, TaskStage stage,
                Instant createdAt, Instant completedAt, String resultUrl, String errorMessage) {}
record NewTask(String id, long ownerId, String templateId, String requestId, TaskStage failAt,
               int checkMs, int generateMs, int finalizeMs) {}

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

    @Insert("""
        INSERT INTO tasks (id, owner_id, template_id, request_id, status, fail_at, check_ms, generate_ms, finalize_ms)
        VALUES (#{id}, #{ownerId}, #{templateId}, #{requestId}, 'QUEUED',
                #{failAt, jdbcType=VARCHAR}, #{checkMs}, #{generateMs}, #{finalizeMs})
        ON DUPLICATE KEY UPDATE id = id
        """)
    void insertOrKeep(NewTask task);

    @Insert("INSERT INTO task_assets(task_id, slot_index, asset_id) VALUES (#{taskId}, #{slot}, #{assetId})")
    void link(String taskId, int slot, String assetId);

    @Select(SELECT_TASK + " WHERE t.status = 'QUEUED' ORDER BY t.created_at, t.id LIMIT 1")
    Task nextQueued();

    @Update("UPDATE tasks SET status = 'RUNNING', stage = 'CHECK_INPUTS' WHERE id = #{id} AND status = 'QUEUED'")
    int claim(String id);

    @Update("UPDATE tasks SET stage = #{next} WHERE id = #{id} AND status = 'RUNNING' AND stage = #{previous}")
    int advance(String id, TaskStage previous, TaskStage next);

    @Update("""
        UPDATE tasks SET status = 'SUCCEEDED', result_key = #{key}, completed_at = CURRENT_TIMESTAMP(3)
        WHERE id = #{id} AND status = 'RUNNING' AND stage = 'FINALIZE'
        """)
    int succeed(String id, String key);

    @Update("""
        UPDATE tasks SET status = 'FAILED', error_message = #{message}, completed_at = CURRENT_TIMESTAMP(3)
        WHERE id = #{id} AND status = 'RUNNING'
        """)
    int fail(String id, String message);

    @Update("""
        UPDATE tasks SET status = 'FAILED', error_message = '后台服务重启，制作被中断。',
                         completed_at = CURRENT_TIMESTAMP(3)
        WHERE status = 'RUNNING'
        """)
    int failInterrupted();
}
