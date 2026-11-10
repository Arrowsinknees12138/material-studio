package studio.material;

import java.io.IOException;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.dao.DataAccessException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

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

    @Scheduled(fixedDelayString = "${studio.worker-delay-ms}")
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void processNext() {
        WorkItem item = tasks.lockNextDue();
        if (item == null) {
            return;
        }
        TaskStage stage = item.stage();
        if (stage == null) {
            tasks.schedule(item.id(), TaskStage.CHECK_INPUTS, item.checkMs(), null);
            return;
        }

        try {
            if (item.failAt() == stage) {
                throw new StepFailure(stage.label() + "模拟失败。");
            }
            switch (stage) {
                case CHECK_INPUTS -> {
                    steps.checkInputs(item);
                    tasks.schedule(item.id(), TaskStage.GENERATE, item.generateMs(), null);
                }
                case GENERATE -> {
                    String sample = steps.generate(item);
                    tasks.schedule(item.id(), TaskStage.FINALIZE, item.finalizeMs(), sample);
                }
                case FINALIZE -> tasks.succeed(item.id(), steps.finalizeResult(item));
            }
        } catch (DataAccessException error) {
            // A database error rolls back this checkpoint so it can be picked up again.
            throw error;
        } catch (StepFailure error) {
            tasks.fail(item.id(), error.getMessage());
        } catch (IOException | RuntimeException error) {
            log.error("Task {} failed in {}", item.id(), stage, error);
            tasks.fail(item.id(), "制作步骤遇到异常，未能完成。");
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

    void checkInputs(WorkItem item) {
        Template template = catalog.require(item.templateId());
        List<Asset> linkedAssets = assets.findForTask(item.id());
        if (linkedAssets.size() != template.requiredImageCount()
                || linkedAssets.stream().anyMatch(asset -> !storage.readable(asset.storageKey()))) {
            throw new StepFailure("任务引用的图片文件缺失或无法读取。");
        }
    }

    String generate(WorkItem item) {
        return catalog.require(item.templateId()).sampleResult();
    }

    String finalizeResult(WorkItem item) throws IOException {
        return storage.saveResult(item.id(), item.generatedSample());
    }
}

class StepFailure extends RuntimeException {
    StepFailure(String message) {
        super(message);
    }
}
