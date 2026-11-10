package studio.material;

import java.io.IOException;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@DependsOnDatabaseInitialization
class AssetCleanup {
    private static final Logger log = LoggerFactory.getLogger(AssetCleanup.class);
    private final AssetMapper assets;
    private final FileStorage storage;
    private final TransactionTemplate transaction;
    private final long retentionSeconds;

    AssetCleanup(AssetMapper assets, FileStorage storage, PlatformTransactionManager transactions,
                 @Value("${studio.assets.retention-seconds}") long retentionSeconds) {
        if (retentionSeconds < 1) {
            throw new IllegalArgumentException("ASSET_RETENTION_SECONDS must be positive");
        }
        this.assets = assets;
        this.storage = storage;
        this.retentionSeconds = retentionSeconds;
        this.transaction = new TransactionTemplate(transactions);
        this.transaction.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
    }

    @Scheduled(fixedDelayString = "${studio.assets.cleanup-interval-ms}")
    void purge() {
        transaction.executeWithoutResult(status -> {
            for (AssetFile expired : assets.lockExpiredUnreferenced(retentionSeconds)) {
                assets.markPurging(expired.id());
            }
        });

        // Keep PURGING records until the file is gone. Deletion can be repeated after a crash.
        for (AssetFile pending : assets.pendingPurge()) {
            try {
                storage.delete(pending.storageKey());
                assets.deletePurged(pending.id());
            } catch (IOException error) {
                log.warn("Could not remove expired asset {}", pending.id(), error);
            }
        }
    }
}
