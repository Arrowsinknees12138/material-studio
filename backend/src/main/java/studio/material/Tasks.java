package studio.material;

import java.util.HashSet;
import java.util.List;
import java.util.UUID;

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

record Submission(String templateId, List<String> assetIds, UUID requestId, TaskStage failAt, Integer delayMs) {}

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
        List<String> ids = input.assetIds();
        if (ids == null || ids.size() != template.requiredImageCount() || new HashSet<>(ids).size() != ids.size()) {
            throw badRequest("请为每个槽位上传图片，素材记录不能重复。");
        }
        for (String id : ids) {
            Asset asset = id == null ? null : assets.findOwned(id, ownerId);
            if (asset == null || !template.id().equals(asset.templateId()) ||
                    !template.view().acceptedMimeTypes().contains(asset.contentType())
                    || asset.byteSize() > template.maxFileSizeBytes()) {
                throw badRequest("有素材不属于当前账号或不符合模板要求，请重新上传。");
            }
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
