// /functions/ 以下（サーバー側のコード）はサイトとして公開しない
export const onRequest = () => new Response('Not found', { status: 404 });
