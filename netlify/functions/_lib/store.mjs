// Where demo accounts are kept: Netlify Blobs (free, built into Netlify) in production,
// a plain in-memory map for local tests (DEMO_MEMORY=1).
let mem = null;

export async function demoStore() {
  if (process.env.DEMO_MEMORY === '1') {
    mem = mem || new Map();
    return {
      get: async (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
      set: async (k, v) => {
        mem.set(k, JSON.stringify(v));
      },
    };
  }
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name: 'demo-accounts', consistency: 'strong' });
  return {
    get: (k) => s.get(k, { type: 'json' }),
    set: (k, v) => s.setJSON(k, v),
  };
}
