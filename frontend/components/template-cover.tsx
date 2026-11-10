"use client";

/* eslint-disable @next/next/no-img-element -- Covers are small local JPEGs served by Java. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";

const coverTimeoutMs = 8000;

export function TemplateCover({ url, title, className, decorative = false }: {
  url: string;
  title: string;
  className: string;
  decorative?: boolean;
}) {
  const [{ attempt, state }, setImage] = useState<{ attempt: number; state: "loading" | "ready" | "failed" }>({
    attempt: 0, state: "loading",
  });
  const cover = useRef<HTMLDivElement>(null);

  const finish = useCallback((next: "ready" | "failed") => {
    setImage((current) => current.attempt === attempt && current.state === "loading"
      ? { attempt, state: next } : current);
  }, [attempt]);

  useEffect(() => {
    if (state !== "loading") return;
    const timer = setTimeout(() => finish("failed"), coverTimeoutMs);
    return () => clearTimeout(timer);
  }, [finish, state]);

  return (
    <Box ref={cover} tabIndex={-1} className={"template-cover " + className}
      sx={decorative || state !== "ready" ? undefined : { "--cover-backdrop": `url("${url}")` }}>
      {state !== "failed" && (
        <img key={attempt} src={url + (attempt ? "?attempt=" + attempt : "")}
          alt={decorative ? "" : title + "模板封面"} hidden={state !== "ready"}
          onLoad={() => finish("ready")} onError={() => finish("failed")} />
      )}
      {state === "failed" && (
        <Stack className="template-cover-feedback">
          <Typography variant="caption" role="status">封面暂时无法加载。</Typography>
          <Button size="small" type="button" aria-label={"重试" + title + "封面"} onClick={() => {
            cover.current?.focus();
            setImage((current) => ({ attempt: current.attempt + 1, state: "loading" }));
          }}>重试封面</Button>
        </Stack>
      )}
    </Box>
  );
}
