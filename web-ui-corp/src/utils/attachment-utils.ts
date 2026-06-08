import type { PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjsLib from "pdfjs-dist";
import { i18n } from "./i18n.js";

// Configure PDF.js worker - we'll need to bundle this
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export interface Attachment {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string; // base64 encoded original data (without data URL prefix)
	extractedText?: string; // For documents: <pdf filename="..."><page number="1">text</page></pdf>
	preview?: string; // base64 image preview (first page for PDFs, or same as content for images)
}

/**
 * Load an attachment from various sources
 * @param source - URL string, File, Blob, or ArrayBuffer
 * @param fileName - Optional filename override
 * @returns Promise<Attachment>
 * @throws Error if loading fails
 */
export async function loadAttachment(
	source: string | File | Blob | ArrayBuffer,
	fileName?: string,
): Promise<Attachment> {
	let arrayBuffer: ArrayBuffer;
	let detectedFileName = fileName || "unnamed";
	let mimeType = "application/octet-stream";
	let size = 0;

	// Convert source to ArrayBuffer
	if (typeof source === "string") {
		// It's a URL - fetch it
		const response = await fetch(source);
		if (!response.ok) {
			throw new Error(i18n("Failed to fetch file"));
		}
		arrayBuffer = await response.arrayBuffer();
		size = arrayBuffer.byteLength;
		mimeType = response.headers.get("content-type") || mimeType;
		if (!fileName) {
			// Try to extract filename from URL
			const urlParts = source.split("/");
			detectedFileName = urlParts[urlParts.length - 1] || "document";
		}
	} else if (source instanceof File) {
		arrayBuffer = await source.arrayBuffer();
		size = source.size;
		mimeType = source.type || mimeType;
		detectedFileName = fileName || source.name;
	} else if (source instanceof Blob) {
		arrayBuffer = await source.arrayBuffer();
		size = source.size;
		mimeType = source.type || mimeType;
	} else if (source instanceof ArrayBuffer) {
		arrayBuffer = source;
		size = source.byteLength;
	} else {
		throw new Error(i18n("Invalid source type"));
	}

	// Convert ArrayBuffer to base64 - handle large files properly
	const uint8Array = new Uint8Array(arrayBuffer);
	let binary = "";
	const chunkSize = 0x8000; // Process in 32KB chunks to avoid stack overflow
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.slice(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	const base64Content = btoa(binary);

	// Detect type and process accordingly
	const id = `${detectedFileName}_${Date.now()}_${Math.random()}`;

	// Check if it's a PDF
	if (mimeType === "application/pdf" || detectedFileName.toLowerCase().endsWith(".pdf")) {
		const { extractedText, preview } = await processPdf(arrayBuffer, detectedFileName);
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: "application/pdf",
			size,
			content: base64Content,
			extractedText,
			preview,
		};
	}

	// Check if it's a DOCX file
	if (
		mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
		detectedFileName.toLowerCase().endsWith(".docx")
	) {
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			size,
			content: base64Content,
		};
	}

	// Check if it's a PPTX file
	if (
		mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
		detectedFileName.toLowerCase().endsWith(".pptx")
	) {
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			size,
			content: base64Content,
		};
	}

	// Check if it's an Excel file (XLSX/XLS)
	const excelMimeTypes = [
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-excel",
	];
	if (
		excelMimeTypes.includes(mimeType) ||
		detectedFileName.toLowerCase().endsWith(".xlsx") ||
		detectedFileName.toLowerCase().endsWith(".xls")
	) {
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: mimeType.startsWith("application/vnd")
				? mimeType
				: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			size,
			content: base64Content,
		};
	}

	// Check if it's an image
	if (mimeType.startsWith("image/")) {
		return {
			id,
			type: "image",
			fileName: detectedFileName,
			mimeType,
			size,
			content: base64Content,
			preview: base64Content, // For images, preview is the same as content
		};
	}

	// Check if it's a text document
	const textExtensions = [
		".txt",
		".md",
		".json",
		".xml",
		".html",
		".css",
		".js",
		".ts",
		".jsx",
		".tsx",
		".yml",
		".yaml",
	];
	const isTextFile =
		mimeType.startsWith("text/") || textExtensions.some((ext) => detectedFileName.toLowerCase().endsWith(ext));

	if (isTextFile) {
		const decoder = new TextDecoder();
		const text = decoder.decode(arrayBuffer);
		return {
			id,
			type: "document",
			fileName: detectedFileName,
			mimeType: mimeType.startsWith("text/") ? mimeType : "text/plain",
			size,
			content: base64Content,
			extractedText: text,
		};
	}

	throw new Error(`Unsupported file type: ${mimeType}`);
}

async function processPdf(
	arrayBuffer: ArrayBuffer,
	fileName: string,
): Promise<{ extractedText: string; preview?: string }> {
	let pdf: PDFDocumentProxy | null = null;
	try {
		pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

		// Extract text with page structure
		let extractedText = `<pdf filename="${fileName}">`;
		for (let i = 1; i <= pdf.numPages; i++) {
			const page = await pdf.getPage(i);
			const textContent = await page.getTextContent();
			const pageText = textContent.items
				.map((item: any) => item.str)
				.filter((str: string) => str.trim())
				.join(" ");
			extractedText += `\n<page number="${i}">\n${pageText}\n</page>`;
		}
		extractedText += "\n</pdf>";

		// Generate preview from first page
		const preview = await generatePdfPreview(pdf);

		return { extractedText, preview };
	} catch (error) {
		console.error("Error processing PDF:", error);
		throw new Error(`Failed to process PDF: ${String(error)}`);
	} finally {
		// Clean up PDF resources
		if (pdf) {
			pdf.destroy();
		}
	}
}

async function generatePdfPreview(pdf: PDFDocumentProxy): Promise<string | undefined> {
	try {
		const page = await pdf.getPage(1);
		const viewport = page.getViewport({ scale: 1.0 });

		// Create canvas with reasonable size for thumbnail (160x160 max)
		const scale = Math.min(160 / viewport.width, 160 / viewport.height);
		const scaledViewport = page.getViewport({ scale });

		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (!context) {
			return undefined;
		}

		canvas.height = scaledViewport.height;
		canvas.width = scaledViewport.width;

		const renderContext = {
			canvasContext: context,
			viewport: scaledViewport,
			canvas: canvas,
		};
		await page.render(renderContext).promise;

		// Return base64 without data URL prefix
		return canvas.toDataURL("image/png").split(",")[1];
	} catch (error) {
		console.error("Error generating PDF preview:", error);
		return undefined;
	}
}
