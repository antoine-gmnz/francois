import { memo, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import type { ToolImage } from '../../../contract/common';
import { Modal } from '../../ui/Modal';
import { imageCaption, imageFileName, stepImage } from './tool-images';
import './conversation.css';

// tool-images: the images a tool handed back to the model, shown under its
// row the way Claude Code's own app shows them — a strip of thumbnails, each
// opening a full-size viewer. The file is the core's (decoded off the
// tool_result into `app_data/tool-images/`, a dir the core grants the asset
// protocol at startup), so `convertFileSrc` resolves it here and after a reopen.

function assetSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return '';
  }
}

function Thumb({ image, onOpen }: { image: ToolImage; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? '' : assetSrc(image.path);
  const caption = imageCaption(image);
  return (
    <button
      type="button"
      className="tool-images__thumb"
      title={`${imageFileName(image)} · ${caption}`}
      aria-label={`Open image ${imageFileName(image)}`}
      onClick={(e) => {
        // The row above may be a disclosure; opening an image must not toggle it.
        e.stopPropagation();
        onOpen();
      }}
    >
      {src ? (
        <img className="tool-images__img" src={src} alt={imageFileName(image)} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="tool-images__failed" aria-hidden="true">
          ▣
        </span>
      )}
      <span className="tool-images__caption">{caption}</span>
    </button>
  );
}

function Viewer({ images, index, onIndex, onClose }: { images: ToolImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const image = images[index]!;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = stepImage(index, images.length, e.key);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      onIndex(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, images.length, onIndex]);
  // Portaled: a transcript ancestor with a transform or overflow would otherwise
  // trap the fixed backdrop inside the tool rail.
  return createPortal(
    <Modal onClose={onClose} width={960} align="center" closeOnBackdropClick closeOnEscape className="tool-images__backdrop">
      <div className="tool-images__viewer">
        <div className="tool-images__viewer-head">
          <span className="tool-images__viewer-name">{imageFileName(image)}</span>
          <span className="tool-images__viewer-meta">
            {imageCaption(image)}
            {images.length > 1 && ` · ${index + 1}/${images.length}`}
          </span>
          <button type="button" className="tool-images__close" aria-label="Close image" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="tool-images__stage">
          <img className="tool-images__full" src={assetSrc(image.path)} alt={imageFileName(image)} />
        </div>
      </div>
    </Modal>,
    document.body,
  );
}

function ToolImagesImpl({ images }: { images: ToolImage[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <div className="tool-images">
      {images.map((image, i) => (
        <Thumb key={image.path} image={image} onOpen={() => setOpen(i)} />
      ))}
      {open !== null && open < images.length && <Viewer images={images} index={open} onIndex={setOpen} onClose={close} />}
    </div>
  );
}
export const ToolImages = memo(ToolImagesImpl);
