package studio.material;

import java.io.IOException;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class AssetCleanupTest {
    private final AssetMapper assets = mock(AssetMapper.class);
    private final FileStorage storage = mock(FileStorage.class);
    private final PlatformTransactionManager transactions = mock(PlatformTransactionManager.class);
    private final AssetFile expired = new AssetFile("asset-1", "uploads/asset-1.jpg");

    @Test
    void commitsThePurgeMarkerBeforeRemovingTheFileAndMetadata() throws IOException {
        var transactionStatus = new SimpleTransactionStatus();
        when(transactions.getTransaction(any())).thenReturn(transactionStatus);
        when(assets.lockExpiredUnreferenced(86400)).thenReturn(List.of(expired));
        when(assets.pendingPurge()).thenReturn(List.of(expired));

        new AssetCleanup(assets, storage, transactions, 86400).purge();

        InOrder order = inOrder(assets, storage, transactions);
        order.verify(assets).markPurging(expired.id());
        order.verify(transactions).commit(transactionStatus);
        order.verify(storage).delete(expired.storageKey());
        order.verify(assets).deletePurged(expired.id());
    }

    @Test
    void leavesMetadataInPlaceIfFileRemovalFails() throws IOException {
        when(transactions.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        when(assets.pendingPurge()).thenReturn(List.of(expired));
        doThrow(new IOException("read-only volume")).doNothing().when(storage).delete(expired.storageKey());
        var cleanup = new AssetCleanup(assets, storage, transactions, 86400);

        cleanup.purge();
        verify(assets, never()).deletePurged(expired.id());

        cleanup.purge();
        verify(assets).deletePurged(expired.id());
    }
}
