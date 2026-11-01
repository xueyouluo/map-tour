import { ParseProgress } from './ParseProgress';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent
} from 'react';
import {
  ArrowRight,
  FileImage,
  FileText,
  ImagePlus,
  Loader2,
  Sparkles,
  Upload,
  X
} from 'lucide-react';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ImportExample {
  text: string;
  revision: number;
}

export function ImportPanel({
  onParse,
  busy,
  progressMessage,
  variant = 'compact',
  example,
  draftKey = 'map-tour:import-draft'
}: {
  onParse: (text: string, image?: File | null) => void;
  busy: boolean;
  progressMessage: string;
  variant?: 'compact' | 'home';
  example?: ImportExample;
  draftKey?: string;
}) {
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [fileError, setFileError] = useState('');
  const home = variant === 'home';
  const [restoredDraft, setRestoredDraft] = useState(false);
  const previousDraftKey = useRef(draftKey);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) { setText(saved); setRestoredDraft(true); }
      else if (previousDraftKey.current !== draftKey) {
        // Carry a guest's in-progress import through login; keep accounts separate.
        if (previousDraftKey.current.endsWith(':guest') && !draftKey.endsWith(':guest') && text)
          sessionStorage.setItem(draftKey, text);
        else { setText(''); setRestoredDraft(false); }
      }
    } catch { /* Import remains usable when browser storage is unavailable. */ }
    previousDraftKey.current = draftKey;
  }, [draftKey]);

  function updateText(value: string) {
    setText(value);
    setRestoredDraft(false);
    try {
      if (value) sessionStorage.setItem(draftKey, value);
      else sessionStorage.removeItem(draftKey);
    } catch { /* The current editor still retains the text. */ }
  }

  useEffect(() => {
    if (!example) return;
    updateText(example.text);
    setMode('text');
    setImage(null);
    setFileError('');
    const frame = requestAnimationFrame(() =>
      document.getElementById(inputId)?.focus({ preventScroll: true })
    );
    return () => cancelAnimationFrame(frame);
  }, [example, inputId]);

  useEffect(() => {
    if (!image) {
      setImagePreviewUrl('');
      return;
    }
    const objectUrl = URL.createObjectURL(image);
    setImagePreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image]);

  function handleImageFile(file?: File | null) {
    if (busy) return;
    setFileError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setFileError('只支持上传图片文件。');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError('图片不能超过 8MB。');
      return;
    }
    setImage(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const data = event.clipboardData;
    const file =
      Array.from(data.files).find((item) => item.type.startsWith('image/')) ||
      Array.from(data.items)
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile();
    if (file) {
      event.preventDefault();
      handleImageFile(file);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    handleImageFile(Array.from(event.dataTransfer.files)[0]);
  }

  return (
    <section
      className={`import-box ${home ? 'home-import' : ''}`}
      aria-label="导入行程"
    >
      {home && (
        <div className="home-import-tabs" role="group" aria-label="导入方式">
          <button
            type="button"
            disabled={busy}
            aria-pressed={mode === 'text'}
            onClick={() => setMode('text')}
          >
            <FileText size={17} />
            粘贴行程
          </button>
          <button
            type="button"
            disabled={busy}
            aria-pressed={mode === 'image'}
            onClick={() => setMode('image')}
          >
            <FileImage size={17} />
            上传截图
          </button>
        </div>
      )}
      <label
        className={home ? 'home-sr-only' : 'field-label'}
        htmlFor={inputId}
      >
        行程内容
      </label>
      <textarea
        id={inputId}
        disabled={busy}
        hidden={home && mode === 'image'}
        value={text}
        onChange={(event) => updateText(event.target.value)}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy && !fileError && (text.trim() || image)) {
            event.preventDefault();
            onParse(text, image);
          }
        }}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
        placeholder={
          home
            ? '例如：武汉一日游\n湖北省博物馆 → 湖北美术馆 → 东湖绿道 → 东湖之眼\n\n粘贴你的每日行程，文字、表格都可以。'
            : '粘贴文字、Markdown、CSV/TSV 表格，也可以直接粘贴截图...'
        }
      />
      {restoredDraft && !(home && mode === 'image') && (
        <div className="import-draft-note" role="status">
          <span>已恢复上次未完成的文字</span>
          <button type="button" disabled={busy} onClick={() => updateText('')}>清空草稿</button>
        </div>
      )}
      <div
        className={`import-actions ${home && mode === 'image' ? 'home-image-mode' : ''}`}
      >
        <button
          type="button"
          className="file-button"
          aria-label={image ? '更换行程截图' : '选择行程截图'}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          {home && mode === 'image' ? (
            <ImagePlus size={28} />
          ) : (
            <FileImage size={16} />
          )}
          <span>
            {home && mode === 'image'
              ? '点击选择截图，或拖到这里'
              : image
                ? '更换截图'
                : '上传截图'}
          </span>
          {home && mode === 'image' && (
            <small>支持 JPG、PNG 等图片 · 单张不超过 8MB</small>
          )}
        </button>
        <input
          ref={fileInput}
          hidden
          className="home-file-input"
          type="file"
          accept="image/*"
          disabled={busy}
          aria-label="选择行程截图"
          onChange={(event) => {
            handleImageFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {home && mode === 'text' && (
          <span className="home-import-hint">
            也可以直接粘贴截图 · 单张 8MB 内
          </span>
        )}
      </div>
      {fileError && (
        <div className="import-error" role="alert">
          <span>{fileError}</span>
          <button
            type="button"
            aria-label="关闭图片提示"
            disabled={busy}
            onClick={() => setFileError('')}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {image && imagePreviewUrl && (
        <div className="image-preview">
          <img
            src={imagePreviewUrl}
            alt="已选择的行程截图预览"
            onError={() => {
              setImage(null);
              setFileError('图片无法读取，请重新选择一张图片。');
            }}
          />
          <div className="image-preview-meta">
            <strong>{image.name}</strong>
            <span>
              {image.size < 1024 * 1024
                ? `${Math.max(1, Math.round(image.size / 1024))} KB`
                : `${(image.size / 1024 / 1024).toFixed(1)} MB`}
            </span>
          </div>
          <button
            type="button"
            aria-label="移除图片"
            disabled={busy}
            onClick={() => {
              setImage(null);
              setFileError('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <button
        className={`primary-button ${busy ? 'import-is-busy' : ''}`}
        aria-busy={busy}
        type="button"
        disabled={busy || Boolean(fileError) || (!text.trim() && !image)}
        onClick={() => onParse(text, image)}
      >
        {busy ? (
          <Loader2 className="spin" size={17} />
        ) : home ? (
          <Sparkles size={17} />
        ) : (
          <Upload size={17} />
        )}
        {busy ? '正在整理你的旅程' : home ? '生成我的旅程' : '生成旅程'}
        {home && !busy && <ArrowRight size={17} />}
      </button>
      {busy ? (
        <ParseProgress message={progressMessage} hasImage={Boolean(image)} />
      ) : progressMessage ? (
        <p className="import-progress-note" role="status">
          {progressMessage}
        </p>
      ) : null}
      <p className="import-region-note">目前支持中国大陆行程，暂不支持港澳台及海外。</p>
    </section>
  );
}
