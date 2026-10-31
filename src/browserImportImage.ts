// Preserve screenshot text at its original resolution; only change encoding.
export async function prepareImportImage(file: File): Promise<File> {
  if (file.size < 512 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return file;
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(file);
    // Avoid allocating a second huge pixel buffer on memory-limited devices.
    if (bitmap.width * bitmap.height > 16 * 1024 * 1024) return file;
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/jpeg', 0.94));
    // Keep the original when re-encoding does not save at least 10%.
    if (!blob || blob.size >= file.size * 0.9) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg', lastModified: file.lastModified
    });
  } catch {
    // Browser limitations must not block an otherwise valid original upload.
    return file;
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
}
