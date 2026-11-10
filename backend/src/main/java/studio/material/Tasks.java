package studio.material;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

record TaskPage(List<TaskView> items, String nextCursor) {}

class UnavailableAssets extends RuntimeException {
    private final List<String> ids;

    UnavailableAssets(List<String> ids) {
        super("有素材已失效或不符合模板要求，请重新上传。");
        this.ids = List.copyOf(ids);
    }

    List<String> ids() {
        return ids;
    }
}

record Submission(String templateId, List<String> assetIds, UUID requestId, TaskStage failAt, Integer delayMs) {
    @JsonCreator
    static Submission fromJson(@JsonProperty("templateId") String templateId,
                               @JsonProperty("assetIds") List<String> assetIds,
                               @JsonProperty("requestId") UUID requestId,
                               @JsonProperty("failAt") JsonNode failAt,
                               @JsonProperty("delayMs") JsonNode delayMs) {
        TaskStage stage = null;
        if (failAt != null && !failAt.isNull()) {
            if (!failAt.isTextual()) {
                throw new IllegalArgumentException("failAt must be a stage name");
            }
            stage = TaskStage.valueOf(failAt.textValue());
        }
        Integer delay = null;
        if (delayMs != null && !delayMs.isNull()) {
            if (!delayMs.isIntegralNumber() || !delayMs.canConvertToInt()) {
                throw new IllegalArgumentException("delayMs must be an integer");
            }
            delay = delayMs.intValue();
        }
        return new Submission(templateId, assetIds, requestId, stage, delay);
    }
}

@Service
class Tasks {
    static final int MAX_DELAY_MS = 30_000;
    private final TaskMapper tasks;
    private final AssetMapper assets;
    private final Catalog catalog;
    private final boolean simulationEnabled;
    private final int checkMs;
    private final int generateMs;
    private final int finalizeMs;

    Tasks(TaskMapper tasks, AssetMapper assets, Catalog catalog,
          @Value("${studio.simulation.enabled}") boolean simulationEnabled,
          @Value("${studio.simulation.check-ms}") int checkMs,
          @Value("${studio.simulation.generate-ms}") int generateMs,
          @Value("${studio.simulation.finalize-ms}") int finalizeMs) {
        this.tasks = tasks;
        this.assets = assets;
        this.catalog = catalog;
        this.simulationEnabled = simulationEnabled;
        this.checkMs = delay(checkMs);
        this.generateMs = delay(generateMs);
        this.finalizeMs = delay(finalizeMs);
    }

    @Transactional
    public TaskView submit(long ownerId, Submission input) {
        if (input.requestId() == null) {
            throw badRequest("请提供 requestId。");
        }
        String requestId = input.requestId().toString();
        Task existing = tasks.findByRequest(ownerId, requestId);
        if (existing != null) {
            return existing.view();
        }
        if (!simulationEnabled && (input.failAt() != null || input.delayMs() != null)) {
            throw badRequest("当前环境未启用单次任务模拟控制。");
        }
        Integer delay = input.delayMs() == null ? null : delay(input.delayMs());
        Template template = catalog.require(input.templateId());
        List<String> requested = input.assetIds();
        if (requested == null || requested.size() != template.requiredImageCount()
                || requested.stream().anyMatch(Objects::isNull)) {
            throw badRequest("请为每个槽位上传图片。");
        }
        List<String> ids = requested.stream().map(id -> id.toLowerCase(Locale.ROOT)).toList();
        if (new HashSet<>(ids).size() != ids.size()) {
            throw badRequest("请为每个槽位上传图片，素材记录不能重复。");
        }
        List<String> unavailable = new ArrayList<>();
        for (String id : ids.stream().sorted().toList()) {
            Asset asset = assets.lockOwnedReady(id, ownerId);
            if (asset == null || !template.id().equals(asset.templateId()) ||
                    !template.view().acceptedMimeTypes().contains(asset.contentType())
                    || asset.byteSize() > template.maxFileSizeBytes()) {
                unavailable.add(id);
            }
        }
        if (!unavailable.isEmpty()) {
            throw new UnavailableAssets(unavailable);
        }
        String taskId = UUID.randomUUID().toString();
        tasks.insertOrKeep(new NewTask(taskId, ownerId, template.id(), requestId, input.failAt(),
                delay == null ? checkMs : delay, delay == null ? generateMs : delay,
                delay == null ? finalizeMs : delay));
        Task accepted = tasks.lockByRequest(ownerId, requestId);
        if (taskId.equals(accepted.id())) {
            for (int slot = 0; slot < ids.size(); slot++) {
                tasks.link(taskId, slot, ids.get(slot));
            }
        }
        return accepted.view();
    }

    List<TaskView> list(long ownerId, String templateId) {
        return tasks.listOwned(ownerId, templateId).stream().map(Task::view).toList();
    }

    TaskPage page(long ownerId, String templateId, boolean active, String cursor, int limit) {
        if (limit < 1 || limit > 50) {
            throw badRequest("每页数量应在 1 到 50 之间。");
        }
        Instant beforeTime = null;
        String beforeId = null;
        if (cursor != null) {
            String[] parts = cursor.split("\\|", -1);
            try {
                if (parts.length != 2) throw new IllegalArgumentException();
                beforeTime = Instant.parse(parts[0]);
                beforeId = taskId(parts[1]);
            } catch (DateTimeParseException | IllegalArgumentException invalid) {
                throw badRequest("历史记录游标无效。");
            }
        }
        List<Task> rows = tasks.pageOwned(ownerId, templateId, active, beforeTime, beforeId, limit + 1);
        String next = null;
        if (rows.size() > limit) {
            Task last = rows.get(limit - 1);
            next = last.createdAt() + "|" + last.id();
        }
        return new TaskPage(rows.stream().limit(limit).map(Task::view).toList(), next);
    }

    List<TaskView> updates(long ownerId, String requested) {
        String[] ids = requested.split(",", -1);
        if (ids.length > 50) {
            throw badRequest("每次最多查询 50 条任务。");
        }
        List<String> validIds;
        try {
            validIds = Arrays.stream(ids).map(Tasks::taskId).distinct().toList();
        } catch (IllegalArgumentException invalid) {
            throw badRequest("任务编号无效。");
        }
        return tasks.findOwnedBatch(ownerId, validIds).stream().map(Task::view).toList();
    }

    private static String taskId(String value) {
        String canonical = UUID.fromString(value).toString();
        if (!canonical.equalsIgnoreCase(value)) throw new IllegalArgumentException();
        return canonical;
    }

    Task requireOwned(long ownerId, String id) {
        Task task = tasks.findOwned(id, ownerId);
        if (task == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "未找到该任务。");
        }
        return task;
    }

    private static int delay(int value) {
        if (value < 0 || value > MAX_DELAY_MS) {
            throw badRequest("模拟耗时应介于 0 和 30000 毫秒之间。");
        }
        return value;
    }

    private static ResponseStatusException badRequest(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}

@RestController
@RequestMapping("/api/tasks")
class TaskController {
    private final Accounts accounts;
    private final Tasks tasks;
    private final FileStorage storage;

    TaskController(Accounts accounts, Tasks tasks, FileStorage storage) {
        this.accounts = accounts;
        this.tasks = tasks;
        this.storage = storage;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.ACCEPTED)
    TaskView submit(@RequestBody Submission submission, HttpServletRequest request) {
        return tasks.submit(accounts.requireOwner(request), submission);
    }

    @GetMapping
    List<TaskView> list(@RequestParam(required = false) String templateId, HttpServletRequest request) {
        return tasks.list(accounts.requireOwner(request), templateId);
    }

    @GetMapping("/history")
    TaskPage page(@RequestParam(required = false) String templateId,
                  @RequestParam(defaultValue = "false") boolean active,
                  @RequestParam(required = false) String cursor,
                  @RequestParam(defaultValue = "20") int limit, HttpServletRequest request) {
        return tasks.page(accounts.requireOwner(request), templateId, active, cursor, limit);
    }

    @GetMapping("/updates")
    List<TaskView> updates(@RequestParam String ids, HttpServletRequest request) {
        return tasks.updates(accounts.requireOwner(request), ids);
    }

    @GetMapping("/{id}")
    TaskView detail(@PathVariable String id, HttpServletRequest request) {
        return tasks.requireOwned(accounts.requireOwner(request), id).view();
    }

    @GetMapping("/{id}/result")
    ResponseEntity<Resource> result(@PathVariable String id, HttpServletRequest request) {
        Task task = tasks.requireOwned(accounts.requireOwner(request), id);
        if (task.status() != TaskStatus.SUCCEEDED || task.resultKey() == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "该任务暂无可预览结果。");
        }
        return storage.serve(task.resultKey(), "image/jpeg");
    }
}
