import { TemplateWorkspace } from "../../../components/template-workspace";

export default async function TemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplateWorkspace key={id} id={id} />;
}
