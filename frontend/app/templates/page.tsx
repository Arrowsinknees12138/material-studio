"use client";

import Link from "next/link";
import { Alert, Box, Button, Card, CardActionArea, Chip, Skeleton, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { TemplateCover } from "../../components/template-cover";
import { api, errorMessage, type Catalog } from "../../lib/api";

export default function TemplatesPage() {
  const [selection, setSelection] = useState({ category: "", attempt: 0 });
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const query = selection.category ? "?category=" + encodeURIComponent(selection.category) : "";
    void api<Catalog>("/templates" + query, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setCatalog(response); })
      .catch((error) => { if (!controller.signal.aborted) setProblem(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selection]);

  function load(category: string) {
    setProblem(null);
    setLoading(true);
    setSelection((current) => ({ category, attempt: current.attempt + 1 }));
  }

  return (
    <Box className="catalog-page">
      <Typography component="h1" id="catalog-heading" className="sr-only">模板库</Typography>
      <Stack direction="row" spacing={1} className="catalog-modules">
        <Chip label="图片模板" sx={{ bgcolor: "#29292f" }} />
        <Chip label="制作记录" component={Link} href="/history" clickable />
      </Stack>
      <Box component="section" aria-labelledby="catalog-heading">
        <Stack direction="row" className="catalog-controls">
          <Stack direction="row" spacing={0.25} className="filters" role="group" aria-label="模板分类">
            <Button aria-pressed={selection.category === ""} onClick={() => load("")}>全部</Button>
            {catalog?.categories.map((category) => (
              <Button key={category} aria-pressed={selection.category === category}
                onClick={() => load(category)}>{category}</Button>
            ))}
          </Stack>
          <Typography variant="caption" className="catalog-count">
            {loading ? "正在加载" : problem ? "加载失败" : (catalog?.templates.length ?? 0) + " 款模板"}
          </Typography>
        </Stack>
        {loading ? (
          <Box className="template-grid" aria-busy="true" aria-label="正在加载模板">
            {Array.from({ length: 6 }, (_, index) => <Skeleton variant="rounded" key={index} className="cover-skeleton" />)}
          </Box>
        ) : problem ? (
          <Alert severity="error" action={<Button color="inherit" onClick={() => load(selection.category)}>重新加载</Button>}>
            <Typography component="h2" sx={{ fontWeight: 600 }}>模板暂时无法加载</Typography>{problem}
          </Alert>
        ) : !catalog?.templates.length ? (
          <Stack className="empty-box" spacing={1} sx={{ alignItems: "center" }}>
            <Typography component="h2">这个分类暂时没有模板</Typography>
            <Button onClick={() => load("")}>查看全部模板</Button>
          </Stack>
        ) : (
          <Box className="template-grid">
            {catalog.templates.map((template) => (
              <Card component="article" elevation={0} className="template-card" key={template.id}>
                <TemplateCover key={template.coverUrl} className="catalog-cover"
                  url={template.coverUrl} title={template.title} decorative />
                <CardActionArea component={Link} href={"/templates/" + template.id} className="template-card-link">
                  <Stack className="template-caption">
                    <Typography component="strong">{template.title}</Typography>
                    <Typography variant="caption">需要 {template.requiredImageCount} 张图片</Typography>
                  </Stack>
                </CardActionArea>
              </Card>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
