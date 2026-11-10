package studio.material;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskStepsTest {
    private static final String ID = "task-1";
    private static final String SAMPLE = "moon-result.jpg";
    private static final Asset ASSET = new Asset("asset-1", 7, "moon", "uploads/input.jpg", "image/jpeg", 3);

    private final AssetMapper assets = mock(AssetMapper.class);
    private final Catalog catalog = mock(Catalog.class);
    @TempDir Path root;
    private FileStorage storage;
    private TaskSteps steps;

    @BeforeEach
    void setUp() {
        storage = new FileStorage(root.toString());
        steps = new TaskSteps(assets, catalog, storage);
        when(catalog.require("moon")).thenReturn(new Template("moon", "Moon", "Creative", "One photo",
                "/demo/moon.jpg", SAMPLE, 1, "image/jpeg,image/png", 1024));
    }

    @Test
    void checksTheLinkedFileAndCopiesTheSelectedResultToATaskSpecificPath() throws IOException {
        when(assets.findForTask(ID)).thenReturn(List.of(ASSET));
        try (var input = new ClassPathResource("static/demo/moon.jpg").getInputStream()) {
            storage.save(ASSET.storageKey(), input);
        }

        steps.checkInputs(work(TaskStage.CHECK_INPUTS, null));
        String sample = steps.generate(work(TaskStage.GENERATE, null));
        String key = steps.finalizeResult(work(TaskStage.FINALIZE, sample));

        assertEquals(SAMPLE, sample);
        assertEquals("results/" + ID + ".jpg", key);
        assertTrue(storage.readable(key));
        assertArrayEquals(new ClassPathResource("static/demo/" + SAMPLE).getContentAsByteArray(),
                Files.readAllBytes(root.resolve(key)));
    }

    @Test
    void finalizationReusesThePersistedSampleAndCanReplaceAnEarlierResult() throws IOException {
        String key = "results/" + ID + ".jpg";
        storage.save(key, new ByteArrayInputStream(new byte[]{1, 2, 3}));
        String persistedSample = "desert-result.jpg";

        assertEquals(key, steps.finalizeResult(work(TaskStage.FINALIZE, persistedSample)));

        assertArrayEquals(new ClassPathResource("static/demo/" + persistedSample).getContentAsByteArray(),
                Files.readAllBytes(root.resolve(key)));
        assertFalse(Files.exists(root.resolve(key + ".part")));
        verifyNoInteractions(catalog);
    }

    @Test
    void failsInputCheckWhenLinkedAssetCountDoesNotMatchTheTemplate() {
        when(assets.findForTask(ID)).thenReturn(List.of());

        assertThrows(StepFailure.class, () -> steps.checkInputs(work(TaskStage.CHECK_INPUTS, null)));
    }

    @Test
    void failsInputCheckWhenTheLinkedFileIsMissingFromStorage() {
        when(assets.findForTask(ID)).thenReturn(List.of(ASSET));

        StepFailure failure = assertThrows(StepFailure.class,
                () -> steps.checkInputs(work(TaskStage.CHECK_INPUTS, null)));

        assertEquals("任务引用的图片文件缺失或无法读取。", failure.getMessage());
    }

    private static WorkItem work(TaskStage stage, String sample) {
        return new WorkItem(ID, "moon", stage, null, 10, 20, 30, sample);
    }
}
