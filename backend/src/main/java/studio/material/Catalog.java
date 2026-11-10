package studio.material;

import java.util.List;

import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

record Template(String id, String title, String category, String description, String coverUrl,
                String sampleResult, int requiredImageCount, String acceptedMimeTypes, long maxFileSizeBytes) {
    TemplateView view() {
        return new TemplateView(id, title, category, description, coverUrl, requiredImageCount,
                List.of(acceptedMimeTypes.split(",")), maxFileSizeBytes);
    }
}

record TemplateView(String id, String title, String category, String description, String coverUrl,
                    int requiredImageCount, List<String> acceptedMimeTypes, long maxFileSizeBytes) {}
record CatalogView(List<String> categories, List<TemplateView> templates) {}

@Mapper
interface TemplateMapper {
    String FIELDS = "id, title, category, description, cover_url, sample_result, "
            + "required_image_count, accepted_mime_types, max_file_size_bytes";

    @Select("SELECT " + FIELDS + " FROM templates WHERE id = #{id}")
    Template find(String id);

    @Select("<script>SELECT " + FIELDS + " FROM templates "
            + "<if test=\"category != null\">WHERE category = #{category}</if> "
            + "ORDER BY sort_order, id</script>")
    List<Template> list(String category);

    @Select("SELECT category FROM templates GROUP BY category ORDER BY MIN(sort_order)")
    List<String> categories();
}

@Service
class Catalog {
    private final TemplateMapper templates;

    Catalog(TemplateMapper templates) {
        this.templates = templates;
    }

    Template require(String id) {
        Template template = id == null ? null : templates.find(id);
        if (template == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "未找到该模板。");
        }
        return template;
    }

    CatalogView list(String category) {
        return new CatalogView(templates.categories(), templates.list(category).stream().map(Template::view).toList());
    }
}

@RestController
@RequestMapping("/api/templates")
class TemplateController {
    private final Catalog catalog;

    TemplateController(Catalog catalog) {
        this.catalog = catalog;
    }

    @GetMapping
    CatalogView list(@RequestParam(required = false) String category) {
        return catalog.list(category);
    }

    @GetMapping("/{id}")
    TemplateView detail(@PathVariable String id) {
        return catalog.require(id).view();
    }
}
