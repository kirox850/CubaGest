// Reglas puras de descuentos. Viven en lib (no en la ruta) para que ventas y
// sincronización offline apliquen EXACTAMENTE la misma validación y el mismo
// cálculo, sin depender de la ordenación de módulos de Hono.

export interface DiscountRow {
  id: string;
  companyId: string;
  name: string;
  code: string | null;
  scope: "producto" | "venta";
  type: "porcentaje" | "fijo";
  value: number;
  maxUses: number | null;
  timesUsed: number;
  locationScope: "todas" | "seleccion";
  locationIds: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

// ¿Está disponible este descuento para usar en la ubicación dada?
export function isDiscountAvailable(d: DiscountRow, locationId: string, now = new Date()): { ok: boolean; reason?: string } {
  if (!d.active) return { ok: false, reason: "Descuento inactivo" };
  const endsAt = d.endsAt ? new Date(d.endsAt as any) : null;
  if (d.startsAt && now < new Date(d.startsAt as any)) return { ok: false, reason: "Descuento aún no vigente" };
  if (endsAt && now > endsAt) return { ok: false, reason: "Descuento vencido" };
  if (d.maxUses !== null && d.maxUses !== undefined && d.timesUsed >= d.maxUses) {
    return { ok: false, reason: "Descuento agotado" };
  }
  if (d.locationScope === "seleccion" && !(d.locationIds || []).includes(locationId)) {
    return { ok: false, reason: "No disponible en esta ubicación" };
  }
  return { ok: true };
}

// ── Cálculo del descuento ────────────────────────────────────────────────────
export function computeDiscountAmount(d: DiscountRow, base: number, qty?: number): number {
  let amount = 0;
  if (d.type === "porcentaje") {
    amount = base * (d.value / 100);
  } else {
    // "fijo": por unidad cuando es por producto, total cuando es por venta
    amount = d.scope === "producto" ? d.value * (qty || 1) : d.value;
  }
  return Math.max(0, Math.min(amount, base));
}
