const formats = [
  { type: "image/jpeg", name: "JPEG", extensions: [".jpg", ".jpeg"], signature: [0xff, 0xd8, 0xff] },
  { type: "image/png", name: "PNG", extensions: [".png"], signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

export function imageFormatNames(mimeTypes: string[]) {
  return mimeTypes.map((type) => formats.find((format) => format.type === type)?.name ?? type);
}

export function imageAccept(mimeTypes: string[]) {
  return [
    ...mimeTypes,
    ...formats.filter(({ type }) => mimeTypes.includes(type)).flatMap(({ extensions }) => extensions),
  ].join(",");
}

export async function hasAllowedImageType(file: Blob, mimeTypes: string[]) {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return formats.some(({ type, signature }) =>
    mimeTypes.includes(type) && signature.every((byte, index) => header[index] === byte),
  );
}
