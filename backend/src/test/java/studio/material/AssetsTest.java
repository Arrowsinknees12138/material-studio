package studio.material;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.stream.Stream;
import javax.imageio.ImageIO;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AssetsTest {
    private static final long OWNER = 7L;
    private static final String TEMPLATE_ID = "moon";
    private static final int MAX_BYTES = 1024;
    private final AssetMapper mapper = mock(AssetMapper.class);
    private final Catalog catalog = mock(Catalog.class);
    private final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    private final SimpleTransactionStatus transaction = new SimpleTransactionStatus();
    @TempDir Path root;
    private FileStorage storage;
    private Assets assets;

    @BeforeEach
    void setUp() {
        storage = new FileStorage(root.toString());
        assets = new Assets(mapper, catalog, storage, transactions);
        allowTypes("image/png,image/jpeg");
    }

    @ParameterizedTest
    @CsvSource({"png,image/png", "jpeg,image/jpeg"})
    void savesRealImageBytesAndPublishesPreviewOnlyAfterReady(String format, String mime) throws IOException {
        byte[] bytes = image(format);
        when(transactions.getTransaction(any())).thenReturn(transaction);
        when(mapper.lockUpload(anyString())).thenAnswer(call -> call.getArgument(0));
        MultipartFile file = new MockMultipartFile("file", "misleading.txt", "text/plain", bytes);

        AssetView view = assets.upload(OWNER, TEMPLATE_ID, file);

        var record = ArgumentCaptor.forClass(Asset.class);
        InOrder order = inOrder(mapper, transactions);
        order.verify(mapper).insert(record.capture());
        order.verify(transactions).getTransaction(any());
        order.verify(mapper).lockUpload(view.assetId());
        order.verify(mapper).finishUpload(view.assetId());
        order.verify(transactions).commit(transaction);
        Asset asset = record.getValue();
        assertEquals(OWNER, asset.ownerId());
        assertEquals(TEMPLATE_ID, asset.templateId());
        assertEquals(mime, view.contentType());
        assertEquals(bytes.length, view.byteSize());
        assertEquals("/api/assets/" + asset.id() + "/content", view.previewUrl());
        var preview = storage.serve(asset.storageKey(), asset.contentType());
        assertEquals(mime, preview.getHeaders().getFirst("Content-Type"));
        assertEquals("private, no-store", preview.getHeaders().getCacheControl());
        assertArrayEquals(bytes, preview.getBody().getContentAsByteArray());
    }

    @ParameterizedTest
    @MethodSource("invalidImages")
    void rejectsInvalidFilesWithoutCreatingMetadata(byte[] bytes) {
        MultipartFile file = new MockMultipartFile("file", "image.png", "image/png", bytes);

        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> assets.upload(OWNER, TEMPLATE_ID, file)).getStatusCode());
        verifyNoInteractions(mapper, transactions);
    }

    static Stream<byte[]> invalidImages() throws IOException {
        return Stream.of(new byte[0], new byte[MAX_BYTES + 1], new byte[]{1, 2, 3},
                Arrays.copyOf(image("png"), 20));
    }

    @Test
    void rejectsDecodedImageWhenItsTypeIsNotAllowedByTheTemplate() throws IOException {
        allowTypes("image/png");
        MultipartFile file = new MockMultipartFile("file", "pretend.png", "image/png", image("jpeg"));

        ResponseStatusException error = assertThrows(ResponseStatusException.class,
                () -> assets.upload(OWNER, TEMPLATE_ID, file));

        assertEquals(HttpStatus.BAD_REQUEST, error.getStatusCode());
        assertEquals("模板仅支持 PNG 图片。", error.getReason());
        verifyNoInteractions(mapper, transactions);
    }

    @Test
    void unreadableImageErrorNamesOnlyTheTemplatesAllowedFormats() {
        allowTypes("image/png");
        MultipartFile file = new MockMultipartFile("file", "broken.png", "image/png", new byte[]{1, 2, 3});

        ResponseStatusException error = assertThrows(ResponseStatusException.class,
                () -> assets.upload(OWNER, TEMPLATE_ID, file));

        assertEquals(HttpStatus.BAD_REQUEST, error.getStatusCode());
        assertEquals("请选择可读取的 PNG 图片（不超过 2400 万像素）。", error.getReason());
        verifyNoInteractions(mapper, transactions);
    }

    @Test
    void expiredUploadCannotWriteAFileOrBecomeReady() throws IOException {
        when(transactions.getTransaction(any())).thenReturn(transaction);
        MultipartFile file = new MockMultipartFile("file", "image.png", "image/png", image("png"));

        assertEquals(HttpStatus.CONFLICT, assertThrows(ResponseStatusException.class,
                () -> assets.upload(OWNER, TEMPLATE_ID, file)).getStatusCode());

        verify(mapper).insert(any(Asset.class));
        verify(mapper, never()).finishUpload(anyString());
        verify(transactions).rollback(transaction);
        assertFalse(Files.exists(root.resolve("uploads")));
    }

    @Test
    void interruptedWriteRollsBackReadyStateAndRemovesPartialFile() throws IOException {
        when(transactions.getTransaction(any())).thenReturn(transaction);
        when(mapper.lockUpload(anyString())).thenAnswer(call -> call.getArgument(0));
        byte[] bytes = image("png");
        var failure = new IOException("upload stream disconnected");
        MultipartFile file = mock(MultipartFile.class);
        when(file.getSize()).thenReturn((long) bytes.length);
        when(file.getInputStream()).thenReturn(new ByteArrayInputStream(bytes), new InputStream() {
            private boolean started;

            @Override
            public int read() throws IOException {
                if (started) throw failure;
                started = true;
                return 0x89;
            }
        });

        assertSame(failure, assertThrows(IOException.class, () -> assets.upload(OWNER, TEMPLATE_ID, file)));

        var record = ArgumentCaptor.forClass(Asset.class);
        verify(mapper).insert(record.capture());
        verify(mapper, never()).finishUpload(anyString());
        verify(transactions).rollback(transaction);
        Path target = root.resolve(record.getValue().storageKey());
        assertFalse(Files.exists(target));
        assertFalse(Files.exists(target.resolveSibling(target.getFileName() + ".part")));
    }

    private void allowTypes(String types) {
        when(catalog.require(TEMPLATE_ID)).thenReturn(new Template(TEMPLATE_ID, "Moon", "Creative", "One photo",
                "/demo/moon.jpg", "moon-result.jpg", 1, types, MAX_BYTES));
    }

    private static byte[] image(String format) throws IOException {
        var bytes = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(new BufferedImage(2, 2, BufferedImage.TYPE_INT_RGB), format, bytes));
        return bytes.toByteArray();
    }
}
