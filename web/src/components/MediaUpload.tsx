import { motion } from "framer-motion";
import { FileText, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { createOperationId } from "@/lib/mutationOutcome";
import { reconcileUpload, uploadSignedFile } from "@/lib/signedUpload";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Kind = "image" | "pdf";

interface MediaUploadProps {
  kind: Kind;
  value: string | null;
  onChange: (url: string | null) => void;
}

const accept: Record<Kind, string> = {
  image: "image/png,image/jpeg,image/gif,image/webp",
  pdf: "application/pdf",
};

export function MediaUpload({ kind, value, onChange }: MediaUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Survives a failed attempt so the retry keeps the same object path. Cleared
  // only once the outcome is settled one way or the other.
  const uploadIdRef = useRef<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    if (kind === "image" && !file.type.startsWith("image/")) {
      toast.error("That's not an image file");
      return;
    }
    if (kind === "pdf" && file.type !== "application/pdf") {
      toast.error("That's not a PDF file");
      return;
    }
    setUploading(true);
    try {
      // One intent, one object path, for as long as it takes to settle. A second
      // attempt reuses this id so it overwrites its own object instead of
      // scattering half-written ones across the bucket.
      const uploadId = uploadIdRef.current ?? createOperationId();
      uploadIdRef.current = uploadId;

      const attempt = await uploadSignedFile({ uploadId, kind, file });

      if (attempt.status === "uploaded") {
        uploadIdRef.current = null;
        onChange(attempt.publicUrl);
        toast.success("Uploaded");
        return;
      }

      // The PUT's outcome is unknown. Ask storage rather than guessing.
      const settled = await reconcileUpload(attempt.publicUrl, file);
      if (settled.status === "confirmed") {
        uploadIdRef.current = null;
        onChange(settled.publicUrl);
        toast.success("Uploaded");
        return;
      }
      if (settled.status === "absent") {
        // Keeping the id is the point: retrying writes to the same path.
        toast.error("The upload did not complete. Try again.");
        return;
      }
      if (settled.status === "mismatched") {
        toast.error("Something else is already stored at that address. Try again with a new file.");
        uploadIdRef.current = null;
        return;
      }
      toast.error("Couldn't confirm whether the upload finished. Check before replacing it.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  if (value) {
    return (
      <div className="relative overflow-hidden rounded-md border bg-card/40">
        {kind === "image" ? (
          <img src={value} alt="" className="max-h-64 w-full object-contain" />
        ) : (
          <a
            href={value}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 px-4 py-5 text-sm hover:bg-accent/40"
          >
            <FileText className="size-5 text-muted-foreground" />
            <span className="truncate">{value.split("/").pop()}</span>
          </a>
        )}
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            <Upload className="size-3.5" />
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(null)}
            disabled={uploading}
          >
            <X className="size-3.5" />
            Remove
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={accept[kind]}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </div>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={() => inputRef.current?.click()}
      disabled={uploading}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) handleFile(file);
      }}
      whileHover={{ scale: 1.005 }}
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-card/30 px-6 py-8 text-sm transition-colors",
        dragOver && "border-foreground/40 bg-accent/30",
        uploading && "cursor-wait opacity-70",
      )}
    >
      {uploading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : kind === "image" ? (
        <ImageIcon className="size-5 text-muted-foreground" />
      ) : (
        <FileText className="size-5 text-muted-foreground" />
      )}
      <div className="text-center">
        <p className="font-medium">{uploading ? "Uploading…" : "Drop or click to upload"}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {kind === "image" ? "PNG, JPG, GIF, WebP" : "PDF"}
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept[kind]}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </motion.button>
  );
}
