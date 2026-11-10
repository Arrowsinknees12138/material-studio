package studio.material;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Iterator;
import java.util.List;
import java.util.UUID;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;

import jakarta.servlet.http.HttpServletRequest;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

record Asset(String id, long ownerId, String templateId, String storageKey, String contentType, long byteSize) {
    AssetView view() {
        return new AssetView(id, "/api/assets/" + id + "/content", contentType, byteSize);
    }
}
record AssetFile(String id, String storageKey) {}

record AssetView(String assetId, String previewUrl, String contentType, long byteSize) {}

@Mapper
interface AssetMapper {
    String OWNED_READY = """
        SELECT id, owner_id, template_id, storage_key, content_type, byte_size
        FROM assets WHERE id = #{id} AND owner_id = #{ownerId} AND state = 'READY'
        """;

    @Select(OWNED_READY)
    Asset findOwned(String id, long ownerId);

    @Select(OWNED_READY + " FOR SHARE")
    Asset lockOwnedReady(String id, long ownerId);

    @Select("SELECT id FROM assets WHERE id = #{id} AND state = 'UPLOADING' FOR UPDATE")
    String lockUpload(String id);

    @Update("UPDATE assets SET state = 'READY', created_at = CURRENT_TIMESTAMP(3) WHERE id = #{id}")
    void finishUpload(String id);

    @Select("""
        SELECT a.id, a.owner_id, a.template_id, a.storage_key, a.content_type, a.byte_size
        FROM task_assets link JOIN assets a ON a.id = link.asset_id
        WHERE link.task_id = #{taskId} ORDER BY link.slot_index
        """)
    List<Asset> findForTask(String taskId);

    @Insert("""
        INSERT INTO assets(id, owner_id, template_id, storage_key, content_type, byte_size, state)
        VALUES (#{id}, #{ownerId}, #{templateId}, #{storageKey}, #{contentType}, #{byteSize}, 'UPLOADING')
        """)
    void insert(Asset asset);

    @Select("""
        SELECT a.id, a.storage_key
        FROM assets a
        WHERE a.state IN ('READY', 'UPLOADING')
          AND a.created_at <= TIMESTAMPADD(SECOND, -#{retentionSeconds}, CURRENT_TIMESTAMP(3))
          AND NOT EXISTS (SELECT 1 FROM task_assets link WHERE link.asset_id = a.id)
        ORDER BY a.state, a.created_at, a.id
        LIMIT 100 FOR UPDATE OF a SKIP LOCKED
        """)
    List<AssetFile> lockExpiredUnreferenced(long retentionSeconds);

    @Update("""
        UPDATE assets a SET state = 'PURGING'
        WHERE a.id = #{id} AND a.state IN ('READY', 'UPLOADING')
          AND NOT EXISTS (SELECT 1 FROM task_assets link WHERE link.asset_id = a.id)
        """)
    void markPurging(String id);

    @Select("""
        SELECT id, storage_key FROM assets WHERE state = 'PURGING'
        ORDER BY created_at, id LIMIT 100
        """)
    List<AssetFile> pendingPurge();

    @Delete("DELETE FROM assets WHERE id = #{id} AND state = 'PURGING'")
    void deletePurged(String id);
}

@Service
class FileStorage {
    private final Path root;

    FileStorage(@Value("${studio.storage-path}") String root) {
        this.root = Path.of(root).toAbsolutePath().normalize();
    }

    void save(String key, InputStream source) throws IOException {
        Path target = resolve(key);
        Files.createDirectories(target.getParent());
        Path temp = resolve(key + ".part");
        try {
            Files.copy(source, temp, StandardCopyOption.REPLACE_EXISTING);
            Files.move(temp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    boolean readable(String key) {
        Path file = resolve(key);
        return Files.isRegularFile(file) && Files.isReadable(file);
    }

    ResponseEntity<Resource> serve(String key, String contentType) {
        if (!readable(key)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "图片文件已不可用。");
        }
        return ResponseEntity.ok().header("Cache-Control", "private, no-store")
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.parseMediaType(contentType))
                .body(new FileSystemResource(resolve(key)));
    }

    String saveResult(String taskId, String sample) throws IOException {
        String key = "results/" + taskId + ".jpg";
        try (InputStream source = new ClassPathResource("static/demo/" + sample).getInputStream()) {
            save(key, source);
        }
        return key;
    }

    void delete(String key) throws IOException {
        Files.deleteIfExists(resolve(key + ".part"));
        Files.deleteIfExists(resolve(key));
    }

    private Path resolve(String key) {
        Path path = root.resolve(key).normalize();
        if (!path.startsWith(root)) {
            throw new IllegalArgumentException("Invalid storage key");
        }
        return path;
    }
}

@Service
class Assets {
    private final AssetMapper assets;
    private final Catalog catalog;
    private final FileStorage storage;

    private final TransactionTemplate uploadTransaction;

    Assets(AssetMapper assets, Catalog catalog, FileStorage storage, PlatformTransactionManager transactions) {
        this.assets = assets;
        this.catalog = catalog;
        this.storage = storage;
        this.uploadTransaction = new TransactionTemplate(transactions);
    }

    AssetView upload(long ownerId, String templateId, MultipartFile file) throws IOException {
        Template template = catalog.require(templateId);
        if (file.isEmpty() || file.getSize() > template.maxFileSizeBytes()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "图片为空或超过模板大小上限。");
        }
        String type = imageType(file);
        if (!template.view().acceptedMimeTypes().contains(type)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "模板仅支持 JPEG 或 PNG 图片。");
        }
        String id = UUID.randomUUID().toString();
        String key = "uploads/" + id + (type.equals("image/png") ? ".png" : ".jpg");
        Asset asset = new Asset(id, ownerId, templateId, key, type, file.getSize());
        // Commit the upload record first so an interrupted file write remains discoverable.
        assets.insert(asset);
        try {
            uploadTransaction.executeWithoutResult(status -> {
                if (assets.lockUpload(id) == null) {
                    throw new ResponseStatusException(HttpStatus.CONFLICT, "上传已过期，请重新选择图片。");
                }
                try (InputStream input = file.getInputStream()) {
                    storage.save(key, input);
                } catch (IOException error) {
                    throw new UncheckedIOException(error);
                }
                assets.finishUpload(id);
            });
        } catch (UncheckedIOException error) {
            throw error.getCause();
        }
        return asset.view();
    }

    Asset requireOwned(String id, long ownerId) {
        Asset asset = assets.findOwned(id, ownerId);
        if (asset == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "未找到可用素材。");
        }
        return asset;
    }

    private String imageType(MultipartFile file) {
        try (InputStream raw = file.getInputStream(); ImageInputStream input = ImageIO.createImageInputStream(raw)) {
            if (input != null) {
                Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
                if (readers.hasNext()) {
                    ImageReader reader = readers.next();
                    try {
                        reader.setInput(input, true, true);
                        String type = switch (reader.getFormatName().toLowerCase(java.util.Locale.ROOT)) {
                            case "jpeg" -> "image/jpeg";
                            case "png" -> "image/png";
                            default -> throw invalidImage();
                        };
                        if ((long) reader.getWidth(0) * reader.getHeight(0) <= Template.MAX_IMAGE_PIXELS) {
                            reader.read(0);
                            return type;
                        }
                    } finally {
                        reader.dispose();
                    }
                }
            }
        } catch (IOException | IllegalArgumentException error) {
            throw invalidImage();
        }
        throw invalidImage();
    }

    private ResponseStatusException invalidImage() {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, "请选择可读取的 JPEG 或 PNG 图片（不超过 "
                + Template.MAX_IMAGE_PIXELS / 10_000 + " 万像素）。");
    }
}

@RestController
@RequestMapping("/api/assets")
class AssetController {
    private final Accounts accounts;
    private final Assets assets;
    private final FileStorage storage;

    AssetController(Accounts accounts, Assets assets, FileStorage storage) {
        this.accounts = accounts;
        this.assets = assets;
        this.storage = storage;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    AssetView upload(@RequestParam String templateId, @RequestParam MultipartFile file,
                     HttpServletRequest request) throws IOException {
        return assets.upload(accounts.requireOwner(request), templateId, file);
    }

    @GetMapping("/{id}/content")
    ResponseEntity<Resource> content(@PathVariable String id, HttpServletRequest request) {
        Asset asset = assets.requireOwned(id, accounts.requireOwner(request));
        return storage.serve(asset.storageKey(), asset.contentType());
    }
}
