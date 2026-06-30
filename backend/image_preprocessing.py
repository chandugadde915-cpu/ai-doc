"""Image preprocessing for OCR/vision accuracy on phone photos and scans.

This is the single highest-leverage fix for "phone photo / blurry / skewed"
documents: nothing upstream of this corrects lighting, skew, or noise before
OCR and the vision model see the image. Applied only to raster OCR paths
(image-ocr, heic-ocr, pdf-ocr) - text-rich PDFs/Docling never touch this.
"""
from __future__ import annotations

import cv2
import numpy as np


def preprocess_for_ocr(image_path: str, output_path: str) -> dict:
    """Deskew, denoise, and contrast-enhance an image in place at output_path.

    Returns a small report of what was applied, useful for debugging/warnings.
    """
    image = cv2.imread(image_path)
    if image is None:
        return {"applied": [], "error": "could not read image"}

    applied: list[str] = []

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    angle = _estimate_skew_angle(gray)
    if abs(angle) > 0.3:
        # _rotate applies the angle via cv2.getRotationMatrix2D, whose positive direction is
        # counter-clockwise - the opposite sign of what minAreaRect reports as the skew. Negate
        # here or this "correction" doubles the skew instead of removing it.
        gray = _rotate(gray, -angle)
        applied.append(f"deskew({angle:.2f}deg)")

    denoised = cv2.fastNlMeansDenoising(gray, h=8, templateWindowSize=7, searchWindowSize=21)
    applied.append("denoise")

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    contrasted = clahe.apply(denoised)
    applied.append("contrast(CLAHE)")

    sharpen_kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    sharpened = cv2.filter2D(contrasted, -1, sharpen_kernel)
    applied.append("sharpen")

    output = cv2.cvtColor(sharpened, cv2.COLOR_GRAY2BGR)
    cv2.imwrite(output_path, output)

    return {"applied": applied, "skew_angle": angle}


def _estimate_skew_angle(gray: np.ndarray) -> float:
    """Estimate document skew using the minAreaRect of thresholded text pixels."""
    thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    coords = cv2.findNonZero(thresh)
    if coords is None or len(coords) < 50:
        return 0.0

    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = -(90 + angle)
    else:
        angle = -angle

    # minAreaRect on dense text blocks can report near-90deg flips - ignore those,
    # they're almost always noise, not real page rotation.
    if abs(angle) > 20:
        return 0.0
    return angle


def _rotate(gray: np.ndarray, angle: float) -> np.ndarray:
    (h, w) = gray.shape[:2]
    center = (w // 2, h // 2)
    matrix = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(gray, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def estimate_blur_score(image_path: str) -> float:
    """Variance of Laplacian - lower means blurrier. Used to flag low-quality scans."""
    image = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        return 0.0
    return float(cv2.Laplacian(image, cv2.CV_64F).var())
