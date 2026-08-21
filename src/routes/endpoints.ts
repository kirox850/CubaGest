import { apiFetch } from './client';
import { getRefreshToken } from './client';
import type { AuthResponse, RefreshResponse, User, Product, Sale, Expense, PlanInfo, DashboardSummary } from '../types';

export const AuthAPI = {
  login: (email: string, password: string): Promise<AuthResponse> =>
    apiFetch('/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  me: (): Promise<User> => apiFetch('/auth/me'),
  // El backend exige el refreshToken en el body — antes no se mandaba nada
  // y esta llamada siempre fallaba con 400.
  refresh: async (): Promise<RefreshResponse> => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) throw new Error('No hay refresh token guardado');
    return apiFetch('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false });
  },
};

// ─── Planes y suscripción ─────────────────────────────────────────────────────
export const PlanAPI = {
  // La info del plan vive en GET /subscription (la raíz), no en /plan.
  get: (): Promise<PlanInfo> => apiFetch('/subscription'),
};

export const SubscriptionAPI = {
  status: (): Promise<unknown> => apiFetch('/subscription/status'),
  authorizeQvapay: (plan: string): Promise<{ url?: string }> =>
    apiFetch('/subscription/authorize', { method: 'POST', body: { plan } }),
  // Cancela la renovación automática. La empresa sigue en su plan actual
  // hasta que venza el período ya pagado (planExpiry) y ahí cae a free.
  cancel: (): Promise<{ message: string; planExpiry?: string }> =>
    apiFetch('/subscription/cancel', { method: 'DELETE' }),
};

export const DashboardAPI = {
  summary: (): Promise<DashboardSummary> => apiFetch('/dashboard/summary'),
};

export const ProductsAPI = {
  list: (params: Record<string, string> = {}): Promise<Product[]> => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/products${qs ? `?${qs}` : ''}`);
  },
  create: (product: Partial<Product>): Promise<Product> =>
    apiFetch('/products', { method: 'POST', body: product as Record<string, unknown> }),
  update: (id: string, product: Partial<Product>): Promise<Product> =>
    apiFetch(`/products/${id}`, { method: 'PUT', body: product as Record<string, unknown> }),
  remove: (id: string): Promise<unknown> => apiFetch(`/products/${id}`, { method: 'DELETE' }),
  reactivate: (id: string): Promise<unknown> =>
    apiFetch(`/products/${id}`, { method: 'PUT', body: { active: true } }),
  adjustStock: (id: string, type: string, qty: number, reason: string): Promise<unknown> =>
    apiFetch(`/products/${id}/adjust-stock`, {
      method: 'POST',
      body: { type, qty, reason },
    }),
};

export const SalesAPI = {
  list: (params: Record<string, string> = {}): Promise<Sale[]> => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/sales${qs ? `?${qs}` : ''}`);
  },
  create: (sale: Partial<Sale>): Promise<Sale> =>
    apiFetch('/sales', { method: 'POST', body: sale as Record<string, unknown> }),
  update: (id: string, data: Partial<Sale>): Promise<Sale> =>
    apiFetch(`/sales/${id}`, { method: 'PUT', body: data as Record<string, unknown> }),
  voidSale: (id: string): Promise<unknown> => apiFetch(`/sales/${id}/void`, { method: 'POST' }),
  sync: (sales: Partial<Sale>[]): Promise<unknown> =>
    apiFetch('/sales/sync', { method: 'POST', body: { sales } }),
};

export const ExpensesAPI = {
  list: (params: Record<string, string> = {}): Promise<Expense[]> => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/accounting/expenses${qs ? `?${qs}` : ''}`);
  },
  create: (expense: Partial<Expense>): Promise<Expense> =>
    apiFetch('/accounting/expenses', { method: 'POST', body: expense as Record<string, unknown> }),
  remove: (id: string): Promise<unknown> => apiFetch(`/accounting/expenses/${id}`, { method: 'DELETE' }),
};

export const UsersAPI = {
  list: (): Promise<User[]> => apiFetch('/users'),
  create: (user: Partial<User> & { password: string }): Promise<User> =>
    apiFetch('/users', { method: 'POST', body: user as Record<string, unknown> }),
  update: (id: string, user: Partial<User>): Promise<User> =>
    apiFetch(`/users/${id}`, { method: 'PUT', body: user as Record<string, unknown> }),
  remove: (id: string): Promise<unknown> => apiFetch(`/users/${id}`, { method: 'DELETE' }),
};
