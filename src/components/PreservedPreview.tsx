type Preview = { title: string; description: string; image: string | null; url: string; captured_at: string };

export function PreservedPreview({ value }: { value?: string | null }) {
  let preview: Preview;
  try {
    preview = JSON.parse(value || "null");
    if (!preview || typeof preview.title !== "string" || typeof preview.url !== "string") return null;
  } catch { return null; }
  return (
    <section className="mt-5 space-y-2 border-t pt-4 text-xs">
      <h3 className="font-medium">First captured preview</h3>
      <p className="text-muted-foreground">Kept separately from later previews and extracted text.</p>
      {preview.image && <img src={preview.image} alt="First captured preview" loading="lazy" referrerPolicy="no-referrer" className="max-h-40 max-w-full rounded-md object-contain" />}
      <p className="font-medium break-words">{preview.title}</p>
      {preview.description && <p className="break-words text-muted-foreground">{preview.description}</p>}
      <p className="break-all text-muted-foreground">{preview.url}</p>
      <p className="text-muted-foreground">Captured {new Date(preview.captured_at).toLocaleString()}</p>
    </section>
  );
}
