package studio.material;

import java.io.IOException;
import java.util.List;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@DependsOnDatabaseInitialization
class TaskWorker {
    private static final Logger log = LoggerFactory.getLogger(TaskWorker.class);
    private final TaskMapper tasks;
    private final TaskSteps steps;

    TaskWorker(TaskMapper tasks, TaskSteps steps) {
        this.tasks = tasks;
        this.steps = steps;
    }

    @PostConstruct
    void recoverInterrupted() {
        tasks.failInterrupted();
    }

    @Scheduled(fixedDelayString = "${studio.worker-delay-ms}")
    void processNext() {
        Task task = tasks.nextQueued();
        if (task == null || tasks.claim(task.id()) != 1) {
            return;
        }
        TaskStage stage = TaskStage.CHECK_INPUTS;
        try {
            steps.checkInputs(task);
            if (tasks.advance(task.id(), stage, TaskStage.GENERATE) != 1) {
                return;
            }
            stage = TaskStage.GENERATE;
            String sample = steps.generate(task);
            if (tasks.advance(task.id(), stage, TaskStage.FINALIZE) != 1) {
                return;
            }
            stage = TaskStage.FINALIZE;
            String resultKey = steps.finalizeResult(task, sample);
            tasks.succeed(task.id(), resultKey);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            tasks.fail(task.id(), "后台服务中断了制作。");
        } catch (StepFailure error) {
            tasks.fail(task.id(), error.getMessage());
        } catch (Exception error) {
            log.error("Task {} failed in {}", task.id(), stage, error);
            tasks.fail(task.id(), "制作步骤遇到异常，未能完成。");
        }
    }
}

@Component
class TaskSteps {
    private final AssetMapper assets;
    private final Catalog catalog;
    private final FileStorage storage;

    TaskSteps(AssetMapper assets, Catalog catalog, FileStorage storage) {
        this.assets = assets;
        this.catalog = catalog;
        this.storage = storage;
    }

    void checkInputs(Task task) throws InterruptedException {
        simulate(task, TaskStage.CHECK_INPUTS, "素材检查");
        Template template = catalog.require(task.templateId());
        List<Asset> linkedAssets = assets.findForTask(task.id());
        if (linkedAssets.size() != template.requiredImageCount()
                || linkedAssets.stream().anyMatch(asset -> !storage.readable(asset.storageKey()))) {
            throw new StepFailure("任务引用的图片文件缺失或无法读取。");
        }
    }

    String generate(Task task) throws InterruptedException {
        simulate(task, TaskStage.GENERATE, "模拟生成");
        return catalog.require(task.templateId()).sampleResult();
    }

    String finalizeResult(Task task, String sample) throws InterruptedException, IOException {
        simulate(task, TaskStage.FINALIZE, "结果整理");
        return storage.saveResult(task.id(), sample);
    }

    private void simulate(Task task, TaskStage stage, String label) throws InterruptedException {
        Thread.sleep(task.delay(stage));
        if (task.failAt() == stage) {
            throw new StepFailure(label + "模拟失败。");
        }
    }
}

class StepFailure extends RuntimeException {
    StepFailure(String message) {
        super(message);
    }
}
