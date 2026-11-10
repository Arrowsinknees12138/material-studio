package studio.material;

import java.util.List;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.boot.autoconfigure.web.servlet.MultipartProperties;
import org.springframework.util.unit.DataSize;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CatalogTest {
    @ParameterizedTest
    @CsvSource({"8388608,5242880,5242880", "3145728,5242880,3145728", "8388608,-1,8388608"})
    void listAndDetailUseTheSameEffectiveUploadLimit(long templateLimit, long serverLimit, long effectiveLimit) {
        var template = new Template("moon", "Moon", "Creative", "One photo", "/demo/moon.jpg",
                "moon-result.jpg", 1, "image/jpeg,image/png", templateLimit);
        var mapper = mock(TemplateMapper.class);
        when(mapper.find("moon")).thenReturn(template);
        when(mapper.list("Creative")).thenReturn(List.of(template));
        var multipart = new MultipartProperties();
        multipart.setMaxFileSize(DataSize.ofBytes(serverLimit));
        var catalog = new Catalog(mapper, multipart);

        assertEquals(effectiveLimit, catalog.require("moon").maxFileSizeBytes());
        assertEquals(effectiveLimit, catalog.list("Creative").templates().getFirst().maxFileSizeBytes());
    }
}
