package studio.material;

import java.time.Instant;
import java.util.Collections;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskQueriesTest {
    private static final long OWNER = 42L;
    private static final Instant CREATED = Instant.parse("2026-01-01T00:00:00.123Z");
    private static final String FIRST = "aaaaaaaa-0000-4000-8000-000000000003";
    private static final String SECOND = "aaaaaaaa-0000-4000-8000-000000000002";
    private static final String THIRD = "aaaaaaaa-0000-4000-8000-000000000001";

    private final TaskMapper mapper = mock(TaskMapper.class);
    private final Tasks tasks = new Tasks(mapper, mock(AssetMapper.class), mock(Catalog.class), true, 10, 20, 30);

    @Test
    void usesTheLastVisibleRowAsCursorWhenTimestampsMatch() {
        Task first = succeeded(FIRST);
        Task second = succeeded(SECOND);
        Task third = succeeded(THIRD);
        when(mapper.pageOwned(OWNER, "coast", false, null, null, 3)).thenReturn(List.of(first, second, third));
        when(mapper.pageOwned(OWNER, "coast", false, CREATED, SECOND, 3)).thenReturn(List.of(third));

        TaskPage page = tasks.page(OWNER, "coast", false, null, 2);
        TaskPage next = tasks.page(OWNER, "coast", false, page.nextCursor(), 2);

        assertEquals(List.of(first.view(), second.view()), page.items());
        assertEquals(CREATED + "|" + SECOND, page.nextCursor());
        assertEquals(List.of(third.view()), next.items());
        assertNull(next.nextCursor());
    }

    @Test
    void passesActiveFilterAndDoesNotInventAnExtraPage() {
        when(mapper.pageOwned(OWNER, null, true, null, null, 51)).thenReturn(List.of());

        assertEquals(new TaskPage(List.of(), null), tasks.page(OWNER, null, true, null, 50));

        verify(mapper).pageOwned(OWNER, null, true, null, null, 51);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "2026-01-01T00:00:00Z", "bad-date|" + FIRST, "2026-01-01T00:00:00Z|1-1-1-1-1",
            "1970-01-01T00:00:00.999Z|" + FIRST, "2038-01-19T03:14:08Z|" + FIRST,
            "2026-01-01T00:00:00.000001Z|" + FIRST, "+10000-01-01T00:00:00Z|" + FIRST})
    void rejectsInvalidHistoryCursorsWithoutReadingTheDatabase(String cursor) {
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> tasks.page(OWNER, null, false, cursor, 20)).getStatusCode());
        verifyNoInteractions(mapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"1970-01-01T00:00:01Z", "2038-01-19T03:14:07.999Z"})
    void acceptsTheTimestampColumnBoundaries(String timestamp) {
        Instant expected = Instant.parse(timestamp);
        when(mapper.pageOwned(OWNER, null, false, expected, FIRST, 21)).thenReturn(List.of());

        assertEquals(new TaskPage(List.of(), null), tasks.page(OWNER, null, false, timestamp + "|" + FIRST, 20));
        verify(mapper).pageOwned(OWNER, null, false, expected, FIRST, 21);
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 51})
    void rejectsInvalidHistoryPageSizes(int size) {
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> tasks.page(OWNER, null, false, null, size)).getStatusCode());
        verifyNoInteractions(mapper);
    }

    @Test
    void canonicalizesAndDeduplicatesBatchIdsAndReadsOnlyForTheOwner() {
        Task finished = succeeded(FIRST);
        when(mapper.findOwnedBatch(OWNER, List.of(FIRST, SECOND))).thenReturn(List.of(finished));

        List<TaskView> views = tasks.updates(OWNER, "AAAAAAAA-0000-4000-8000-000000000003," + SECOND + "," + FIRST);

        assertEquals(List.of(finished.view()), views);
        assertEquals("/api/tasks/" + FIRST + "/result", views.getFirst().resultUrl());
        assertEquals(CREATED.plusSeconds(3), views.getFirst().completedAt());
        verify(mapper).findOwnedBatch(OWNER, List.of(FIRST, SECOND));
        verifyNoMoreInteractions(mapper);
    }

    @Test
    void rejectsOversizedBatchesBeforeDeduplication() {
        String ids = String.join(",", Collections.nCopies(51, FIRST));
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> tasks.updates(OWNER, ids)).getStatusCode());
        verifyNoInteractions(mapper);
    }

    @ParameterizedTest
    @ValueSource(strings = {"", FIRST + ",", "1-1-1-1-1", FIRST + ",unknown"})
    void rejectsMalformedBatchIds(String ids) {
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> tasks.updates(OWNER, ids)).getStatusCode());
        verifyNoInteractions(mapper);
    }

    private static Task succeeded(String id) {
        return new Task(id, OWNER, "coast", "Coast", FIRST, TaskStatus.SUCCEEDED, TaskStage.FINALIZE, CREATED,
                CREATED.plusSeconds(3), "results/" + id + ".jpg", null, null, 10, 20, 30);
    }
}
