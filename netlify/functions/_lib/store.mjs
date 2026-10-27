// Where data is kept: Netlify Blobs (free, built into Netlify) in production,
// a plain in-memory map for local tests (DEMO_MEMORY=1).
let mem = null;

export async function demoStore(name = 'demo-accounts') {
  if (process.env.DEMO_MEMORY === '1') {
    mem = mem || new Map();
    const k0 = (k) => name + '|' + k;
    return {
      get: async (k) => (mem.has(k0(k)) ? JSON.parse(mem.get(k0(k))) : null),
      set: async (k, v) => {
        mem.set(k0(k), JSON.stringify(v));
      },
      del: async (k) => {
        mem.delete(k0(k));
      },
    };
  }
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name, consistency: 'strong' });
  return {
    get: (k) => s.get(k, { type: 'json' }),
    set: (k, v) => s.setJSON(k, v),
    del: (k) => s.delete(k),
  };
}
