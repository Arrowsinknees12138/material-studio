"use client";

import Link from "next/link";
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
    <div className="container catalog-page">
      <section className="catalog-intro">
        <div>
          <p className="eyebrow"><span aria-hidden="true" /> 模板库 / TEMPLATE LIBRARY</p>
          <h1>挑一个模板<span>。</span></h1>
          <p className="intro-copy">从明信片到杂志封面，用你的照片开启一次新制作。</p>
        </div>
        <div className="intro-aside" aria-hidden="true"><span>01</span><small>选择模板<br/>开始制作</small></div>
      </section>
      <section aria-labelledby="catalog-heading">
        <div className="catalog-controls">
          <h2 id="catalog-heading">浏览模板</h2>
          <div className="filters" role="group" aria-label="模板分类">
            <button aria-pressed={selection.category === ""} onClick={() => load("")}>全部</button>
            {catalog?.categories.map((category) => (
              <button key={category} aria-pressed={selection.category === category}
                onClick={() => load(category)}>{category}</button>
            ))}
          </div>
          <span className="catalog-count">
            {loading ? "正在加载" : problem ? "加载失败" : (catalog?.templates.length ?? 0) + " 款模板"}
          </span>
        </div>
        {loading ? (
          <div className="template-grid" aria-busy="true" aria-label="正在加载模板">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="cover-skeleton" />)}
          </div>
        ) : problem ? (
          <div className="empty-box" role="alert"><h2>模板暂时无法加载</h2><p>{problem}</p>
            <button className="secondary-button" onClick={() => load(selection.category)}>重新加载</button></div>
        ) : !catalog?.templates.length ? (
          <div className="empty-box"><h2>这个分类暂时没有模板</h2>
            <button className="secondary-button" onClick={() => load("")}>查看全部模板</button></div>
        ) : (
          <div className="template-grid">
            {catalog.templates.map((template) => (
              <article className="template-card" key={template.id}>
                <TemplateCover key={template.coverUrl} className="catalog-cover"
                  url={template.coverUrl} title={template.title} decorative />
                <Link href={"/templates/" + template.id} className="template-card-link">
                  <span className="template-badge">{template.category}</span>
                  <span className="template-caption">
                    <span><strong>{template.title}</strong><small>需要 {template.requiredImageCount} 张图片</small></span>
                    <span className="card-arrow" aria-hidden="true">↗</span>
                  </span>
                </Link>
              </article>
            ))}
          </div>
        )}
      </section>
      <footer className="catalog-footer"><span>MAT.STUDIO / MATERIAL WORKSHOP</span><span>本地模拟制作</span></footer>
    </div>
  );
}
