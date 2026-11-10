package studio.material;

import java.time.Instant;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.mockito.InOrder;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class TaskWorkerTest {
    private final TaskMapper tasks = mock(TaskMapper.class);
    private final TaskSteps steps = mock(TaskSteps.class);
    private final TaskWorker worker = new TaskWorker(tasks, steps);
    private final Task task = new Task("task-1", 1, "coast", "海岸明信片", "request-1", TaskStatus.QUEUED,
            null, Instant.EPOCH, null, null, null, null, 0, 0, 0);

    @BeforeEach
    void queueTask() throws Exception {
        when(tasks.nextQueued()).thenReturn(task);
        when(tasks.claim(task.id())).thenReturn(1);
        when(tasks.advance(task.id(), TaskStage.CHECK_INPUTS, TaskStage.GENERATE)).thenReturn(1);
        when(tasks.advance(task.id(), TaskStage.GENERATE, TaskStage.FINALIZE)).thenReturn(1);
        when(steps.generate(task)).thenReturn("coast.jpg");
        when(steps.finalizeResult(task, "coast.jpg")).thenReturn("results/task-1.jpg");
    }

    @Test
    void savesEachStageBeforeExecutingItAndOnlySucceedsAfterStoringTheImage() throws Exception {
        worker.processNext();

        InOrder order = inOrder(tasks, steps);
        order.verify(tasks).claim(task.id());
        order.verify(steps).checkInputs(task);
        order.verify(tasks).advance(task.id(), TaskStage.CHECK_INPUTS, TaskStage.GENERATE);
        order.verify(steps).generate(task);
        order.verify(tasks).advance(task.id(), TaskStage.GENERATE, TaskStage.FINALIZE);
        order.verify(steps).finalizeResult(task, "coast.jpg");
        order.verify(tasks).succeed(task.id(), "results/task-1.jpg");
        verify(tasks, never()).fail(anyString(), anyString());
    }

    @ParameterizedTest
    @EnumSource(TaskStage.class)
    void failurePreventsAllLaterStages(TaskStage stage) throws Exception {
        StepFailure failure = new StepFailure("模拟失败");
        switch (stage) {
            case CHECK_INPUTS -> doThrow(failure).when(steps).checkInputs(task);
            case GENERATE -> when(steps.generate(task)).thenThrow(failure);
            case FINALIZE -> when(steps.finalizeResult(task, "coast.jpg")).thenThrow(failure);
        }

        worker.processNext();

        verify(tasks).fail(task.id(), "模拟失败");
        verify(tasks, never()).succeed(anyString(), anyString());
        if (stage == TaskStage.CHECK_INPUTS) {
            verify(tasks, never()).advance(anyString(), any(), any());
            verify(steps, never()).generate(task);
        }
        if (stage != TaskStage.FINALIZE) {
            verify(tasks, never()).advance(task.id(), TaskStage.GENERATE, TaskStage.FINALIZE);
            verify(steps, never()).finalizeResult(any(), anyString());
        }
    }

    @Test
    void skipsWorkIfClaimWasLost() {
        when(tasks.claim(task.id())).thenReturn(0);
        worker.processNext();
        verifyNoInteractions(steps);
    }
}
