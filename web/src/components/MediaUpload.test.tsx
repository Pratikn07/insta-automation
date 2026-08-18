// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const uploadSignedFile = vi.fn();
const reconcileUpload = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/lib/signedUpload", () => ({
  uploadSignedFile: (...a: unknown[]) => uploadSignedFile(...a),
  reconcileUpload: (...a: unknown[]) => reconcileUpload(...a),
}));
vi.mock("@/lib/api", () => ({ ApiError: class ApiError extends Error {} }));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));
vi.mock("framer-motion", () => ({
  motion: { button: (props: Record<string, unknown>) => <button {...props} /> },
}));

const { MediaUpload } = await import("./MediaUpload");

const PUBLIC_URL = "https://cdn.example.com/image/50000000-0000-4000-8000-000000000001.png";

function pngFile() {
  return new File([new Uint8Array(1_024)], "photo.png", { type: "image/png" });
}

function renderUpload(onChange = vi.fn()) {
  render(<MediaUpload kind="image" value={null} onChange={onChange} />);
  return onChange;
}

function dropFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pngFile()] } });
}

beforeEach(() => {
  uploadSignedFile.mockReset();
  reconcileUpload.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(cleanup);

describe("MediaUpload outcome handling", () => {
  it("publishes the URL after a confirmed upload", async () => {
    uploadSignedFile.mockResolvedValue({ status: "uploaded", publicUrl: PUBLIC_URL });
    const onChange = renderUpload();

    dropFile();

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(PUBLIC_URL));
    expect(reconcileUpload).not.toHaveBeenCalled();
  });

  it("asks storage what happened when the PUT outcome is unknown", async () => {
    uploadSignedFile.mockResolvedValue({ status: "unknown", publicUrl: PUBLIC_URL });
    reconcileUpload.mockResolvedValue({ status: "confirmed", publicUrl: PUBLIC_URL });
    const onChange = renderUpload();

    dropFile();

    await waitFor(() => expect(reconcileUpload).toHaveBeenCalled());
    // The object is there. The lost response did not mean a lost upload.
    expect(onChange).toHaveBeenCalledWith(PUBLIC_URL);
  });

  it("does not publish a URL when the object is confirmed absent", async () => {
    uploadSignedFile.mockResolvedValue({ status: "unknown", publicUrl: PUBLIC_URL });
    reconcileUpload.mockResolvedValue({ status: "absent" });
    const onChange = renderUpload();

    dropFile();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never publishes a URL it could not verify", async () => {
    uploadSignedFile.mockResolvedValue({ status: "unknown", publicUrl: PUBLIC_URL });
    reconcileUpload.mockResolvedValue({ status: "still_unknown" });
    const onChange = renderUpload();

    dropFile();

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toMatch(/Couldn't confirm/i);
  });

  // The reason the id lives in a ref rather than a local: a retry has to write to
  // the object it may already have half-written, not to a new one.
  it("retries onto the same upload identity after a confirmed absence", async () => {
    uploadSignedFile.mockResolvedValue({ status: "unknown", publicUrl: PUBLIC_URL });
    reconcileUpload.mockResolvedValue({ status: "absent" });
    renderUpload();

    dropFile();
    await waitFor(() => expect(uploadSignedFile).toHaveBeenCalledTimes(1));
    const firstId = uploadSignedFile.mock.calls[0][0].uploadId;

    uploadSignedFile.mockResolvedValue({ status: "uploaded", publicUrl: PUBLIC_URL });
    dropFile();
    await waitFor(() => expect(uploadSignedFile).toHaveBeenCalledTimes(2));

    expect(uploadSignedFile.mock.calls[1][0].uploadId).toBe(firstId);
  });

  it("starts a fresh identity for the next file after a success", async () => {
    uploadSignedFile.mockResolvedValue({ status: "uploaded", publicUrl: PUBLIC_URL });
    renderUpload();

    dropFile();
    await waitFor(() => expect(uploadSignedFile).toHaveBeenCalledTimes(1));
    dropFile();
    await waitFor(() => expect(uploadSignedFile).toHaveBeenCalledTimes(2));

    expect(uploadSignedFile.mock.calls[1][0].uploadId).not.toBe(
      uploadSignedFile.mock.calls[0][0].uploadId,
    );
  });

  it("rejects a file of the wrong kind before signing anything", async () => {
    renderUpload();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [new File(["x"], "doc.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("That's not an image file"));
    expect(uploadSignedFile).not.toHaveBeenCalled();
  });
});
