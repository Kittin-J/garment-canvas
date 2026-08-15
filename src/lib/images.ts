/** 画布和列表优先加载服务端衍生缩略图；查看器与 AI 执行仍使用原图 URL。 */
export function thumbnailImageUrl(ref: string): string {
  const match = /^\/api\/files\/([^/?#]+)$/.exec(ref);
  return match ? `/api/files/${match[1]}/thumbnail` : ref;
}
