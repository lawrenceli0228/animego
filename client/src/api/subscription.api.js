import api from './axiosClient';

export const getSubscriptions  = (status) => api.get('/subscriptions', { params: status ? { status } : {} });
export const getSubscription   = (id)     => api.get(`/subscriptions/${id}`);
export const addSubscription   = (data)   => api.post('/subscriptions', data);
export const updateSubscription = (id, data) => api.patch(`/subscriptions/${id}`, data);
export const removeSubscription = (id)   => api.delete(`/subscriptions/${id}`);
