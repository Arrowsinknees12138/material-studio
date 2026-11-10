package studio.material;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.mockito.InOrder;
import org.springframework.dao.TransientDataAccessResourceException;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class TaskWorkerTest {
    private final TaskMapper tasks = mock(TaskMapper.class);
    private final TaskSteps steps = mock(TaskSteps.class);
    private final TaskWorker worker = new TaskWorker(tasks, steps);

    @Test
    void schedulesEachStageAndSavesGeneratedSampleBeforeFinalization() throws Exception {
        WorkItem queued = item(null, null, null);
        WorkItem check = item(TaskStage.CHECK_INPUTS, null, null);
        WorkItem generate = item(TaskStage.GENERATE, null, null);
        WorkItem finalize = item(TaskStage.FINALIZE, null, "coast.jpg");
        when(tasks.lockNextDue()).thenReturn(queued, check, generate, finalize);
        when(steps.generate(generate)).thenReturn("coast.jpg");
        when(steps.finalizeResult(finalize)).thenReturn("results/task-1.jpg");

        for (int stage = 0; stage < 4; stage++) {
            worker.processNext();
        }

        InOrder order = inOrder(tasks, steps);
        order.verify(tasks).schedule("task-1", TaskStage.CHECK_INPUTS, 10, null);
        order.verify(steps).checkInputs(check);
        order.verify(tasks).schedule("task-1", TaskStage.GENERATE, 20, null);
        order.verify(steps).generate(generate);
        order.verify(tasks).schedule("task-1", TaskStage.FINALIZE, 30, "coast.jpg");
        order.verify(steps).finalizeResult(finalize);
        order.verify(tasks).succeed("task-1", "results/task-1.jpg");
    }

    @ParameterizedTest
    @EnumSource(TaskStage.class)
    void simulatedFailureStopsAtTheCurrentStage(TaskStage stage) {
        when(tasks.lockNextDue()).thenReturn(item(stage, stage, "coast.jpg"));

        worker.processNext();

        verify(tasks).lockNextDue();
        verify(tasks).fail("task-1", stage.label() + "模拟失败。");
        verifyNoMoreInteractions(tasks);
        verifyNoInteractions(steps);
    }

    @ParameterizedTest
    @EnumSource(TaskStage.class)
    void freshWorkerResumesFromThePersistedStage(TaskStage stage) throws Exception {
        WorkItem persisted = item(stage, null, "coast.jpg");
        when(tasks.lockNextDue()).thenReturn(persisted);

        new TaskWorker(tasks, steps).processNext();

        switch (stage) {
            case CHECK_INPUTS -> verify(steps).checkInputs(persisted);
            case GENERATE -> verify(steps).generate(persisted);
            case FINALIZE -> verify(steps).finalizeResult(persisted);
        }
        verifyNoMoreInteractions(steps);
    }

    @Test
    void databaseErrorsLeaveTheCheckpointForRetry() {
        WorkItem check = item(TaskStage.CHECK_INPUTS, null, null);
        when(tasks.lockNextDue()).thenReturn(check);
        doThrow(new TransientDataAccessResourceException("connection interrupted"))
                .when(steps).checkInputs(check);

        assertThrows(TransientDataAccessResourceException.class, worker::processNext);

        verify(tasks, never()).fail(anyString(), anyString());
        verify(tasks).lockNextDue();
        verifyNoMoreInteractions(tasks);
    }

    @Test
    void doesNoWorkWhenNoCheckpointIsDue() {
        worker.processNext();

        verifyNoInteractions(steps);
    }

    private WorkItem item(TaskStage stage, TaskStage failAt, String sample) {
        return new WorkItem("task-1", "coast", stage, failAt, 10, 20, 30, sample);
    }
}
