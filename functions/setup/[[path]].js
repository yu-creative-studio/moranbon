// /setup/ 以下（SQL・Apps Script・テスト）はサイトとして公開しない
export const onRequest = () => new Response('Not found', { status: 404 });
