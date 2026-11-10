package studio.material;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskSubmissionTest {
    private static final long OWNER = 42L;
    private static final UUID REQUEST_ID = UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final String FIRST = "aaaaaaaa-0000-4000-8000-000000000001";
    private static final String SECOND = "bbbbbbbb-0000-4000-8000-000000000002";
    private static final Template TEMPLATE = new Template("coast", "Coast", "Travel", "Two pictures",
            "/demo/coast.jpg", "coast-result.jpg", 2, "image/jpeg,image/png", 1024);

    private final TaskMapper mapper = mock(TaskMapper.class);
    private final AssetMapper assets = mock(AssetMapper.class);
    private final Catalog catalog = mock(Catalog.class);
    private final Tasks tasks = new Tasks(mapper, assets, catalog, true, 10, 20, 30);

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void acceptsQueuedTaskAndLinksSlotsInOriginalOrder(boolean overrideDelays) {
        prepareValidAssets();
        var inserted = new AtomicReference<NewTask>();
        doAnswer(call -> {
            inserted.set(call.getArgument(0));
            return null;
        }).when(mapper).insertOrKeep(any(NewTask.class));
        when(mapper.lockByRequest(OWNER, REQUEST_ID.toString())).thenAnswer(call -> queued(inserted.get().id()));

        TaskView accepted = tasks.submit(OWNER, new Submission("coast",
                List.of(SECOND.toUpperCase(Locale.ROOT), FIRST), REQUEST_ID,
                overrideDelays ? TaskStage.FINALIZE : null, overrideDelays ? 30_000 : null));

        assertEquals(TaskStatus.QUEUED, accepted.status());
        assertNull(accepted.stage());
        assertNull(accepted.resultUrl());
        InOrder order = inOrder(assets, mapper);
        order.verify(assets).lockOwnedReady(FIRST, OWNER);
        order.verify(assets).lockOwnedReady(SECOND, OWNER);
        order.verify(mapper).insertOrKeep(new NewTask(accepted.id(), OWNER, "coast", REQUEST_ID.toString(),
                overrideDelays ? TaskStage.FINALIZE : null, overrideDelays ? 30_000 : 10,
                overrideDelays ? 30_000 : 20, overrideDelays ? 30_000 : 30));
        order.verify(mapper).lockByRequest(OWNER, REQUEST_ID.toString());
        order.verify(mapper).link(accepted.id(), 0, SECOND);
        order.verify(mapper).link(accepted.id(), 1, FIRST);
    }

    @Test
    void returnsExistingOwnerScopedTaskBeforeRevalidatingAssets() {
        Task original = queued("original-task");
        when(mapper.findByRequest(OWNER, REQUEST_ID.toString())).thenReturn(original);

        assertEquals(original.view(), tasks.submit(OWNER, new Submission("coast", null, REQUEST_ID, null, null)));

        verify(mapper).findByRequest(OWNER, REQUEST_ID.toString());
        verifyNoMoreInteractions(mapper);
        verifyNoInteractions(assets, catalog);
    }

    @Test
    void concurrentDuplicateReturnsTheWinnerWithoutLinkingItsAssetsAgain() {
        prepareValidAssets();
        Task winner = queued("winner");
        when(mapper.lockByRequest(OWNER, REQUEST_ID.toString())).thenReturn(winner);

        assertEquals(winner.view(), tasks.submit(OWNER,
                new Submission("coast", List.of(FIRST, SECOND), REQUEST_ID, null, null)));

        verify(mapper).insertOrKeep(any(NewTask.class));
        verify(mapper, never()).link(anyString(), anyInt(), anyString());
    }

    @Test
    void reportsAllUnavailableSlotsBeforeCreatingATask() {
        when(catalog.require("coast")).thenReturn(TEMPLATE);
        when(assets.lockOwnedReady(FIRST, OWNER)).thenReturn(asset(FIRST, "image/gif", 100));

        UnavailableAssets error = assertThrows(UnavailableAssets.class, () -> tasks.submit(OWNER,
                new Submission("coast", List.of(SECOND, FIRST), REQUEST_ID, null, null)));

        assertEquals(List.of(FIRST, SECOND), error.ids());
        verify(assets).lockOwnedReady(SECOND, OWNER);
        verifyNoTaskCreated();
    }

    @Test
    void rejectsAnOversizedAssetAndAnAssetFromADifferentTemplate() {
        when(catalog.require("coast")).thenReturn(TEMPLATE);
        when(assets.lockOwnedReady(FIRST, OWNER)).thenReturn(asset(FIRST, "image/png", 1025));
        when(assets.lockOwnedReady(SECOND, OWNER))
                .thenReturn(new Asset(SECOND, OWNER, "moon", "uploads/other.jpg", "image/jpeg", 100));

        UnavailableAssets error = assertThrows(UnavailableAssets.class, () -> tasks.submit(OWNER,
                new Submission("coast", List.of(FIRST, SECOND), REQUEST_ID, null, null)));

        assertEquals(List.of(FIRST, SECOND), error.ids());
        verifyNoTaskCreated();
    }

    @ParameterizedTest
    @MethodSource("invalidSlots")
    void rejectsInvalidSlotListsBeforeLookingUpAnyAsset(List<String> ids) {
        when(catalog.require("coast")).thenReturn(TEMPLATE);

        assertBadRequest(() -> tasks.submit(OWNER, new Submission("coast", ids, REQUEST_ID, null, null)));

        verifyNoInteractions(assets);
        verifyNoTaskCreated();
    }

    static Stream<List<String>> invalidSlots() {
        return Stream.of(null, List.of(FIRST), Arrays.asList(FIRST, null),
                List.of(FIRST, FIRST.toUpperCase(Locale.ROOT)));
    }

    @ParameterizedTest
    @ValueSource(ints = {-1, 30_001})
    void rejectsOutOfRangeSimulationDelays(int delay) {
        assertBadRequest(() -> tasks.submit(OWNER,
                new Submission("coast", List.of(FIRST, SECOND), REQUEST_ID, null, delay)));
        verifyNoInteractions(assets, catalog);
        verifyNoTaskCreated();
    }

    @Test
    void rejectsSimulationControlsWhenDisabledEvenForZeroDelay() {
        var restricted = new Tasks(mapper, assets, catalog, false, 10, 20, 30);

        assertBadRequest(() -> restricted.submit(OWNER,
                new Submission("coast", List.of(FIRST, SECOND), REQUEST_ID, TaskStage.GENERATE, null)));
        assertBadRequest(() -> restricted.submit(OWNER,
                new Submission("coast", List.of(FIRST, SECOND), REQUEST_ID, null, 0)));

        verifyNoInteractions(assets, catalog);
        verifyNoTaskCreated();
    }

    @Test
    void requiresARequestIdBeforeReadingAnyRecords() {
        assertBadRequest(() -> tasks.submit(OWNER, new Submission("coast", List.of(FIRST, SECOND), null, null, null)));
        verifyNoInteractions(mapper, assets, catalog);
    }

    private void prepareValidAssets() {
        when(catalog.require("coast")).thenReturn(TEMPLATE);
        when(assets.lockOwnedReady(FIRST, OWNER)).thenReturn(asset(FIRST, "image/png", 1024));
        when(assets.lockOwnedReady(SECOND, OWNER)).thenReturn(asset(SECOND, "image/jpeg", 100));
    }

    private void verifyNoTaskCreated() {
        verify(mapper, never()).insertOrKeep(any(NewTask.class));
        verify(mapper, never()).link(anyString(), anyInt(), anyString());
    }

    private static void assertBadRequest(Executable action) {
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class, action).getStatusCode());
    }

    private static Asset asset(String id, String mime, long bytes) {
        return new Asset(id, OWNER, "coast", "uploads/" + id, mime, bytes);
    }

    private static Task queued(String id) {
        return new Task(id, OWNER, "coast", TEMPLATE.title(), REQUEST_ID.toString(), TaskStatus.QUEUED, null,
                Instant.parse("2026-01-01T00:00:00Z"), null, null, null, null, 10, 20, 30);
    }
}
