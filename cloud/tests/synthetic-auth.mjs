// TEST-ONLY synthetic owner callback. Not a credential check and not an auth bypass flag:
// it must only be injected explicitly by tests (never imported by api/index.mjs, server.mjs or production startup).
export const syntheticOwnerAuthorize = async () => ({ verified: true, role: 'owner', subject: 'synthetic-owner', synthetic: true });
