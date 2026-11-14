import { describe, expect, it } from 'vitest';
import { lineTotal, type MenuItem } from './Customer';

const doner: MenuItem = {
  id: 'd', name: { bg: 'Дюнер' }, description: {}, priceCents: 950, imageUrl: null, badgeHit: false,
  prepMinutes: null, allergens: [], maxAddons: 5, base: [],
  addons: [{ id: 'm', name: { bg: 'Месо' }, priceCents: 300, maxQty: 2 }, { id: 's', name: { bg: 'Сос' }, priceCents: 50, maxQty: 1 }],
};

describe('сметка в количката', () => {
  it('цена × брой + добавки', () => {
    expect(lineTotal(doner, 1, [])).toBe(950);
    expect(lineTotal(doner, 2, [{ componentId: 'm', qty: 2 }, { componentId: 's', qty: 1 }])).toBe((950 + 600 + 50) * 2);
    expect(lineTotal(doner, 1, [{ componentId: 'няма', qty: 1 }])).toBe(950);
  });
});
