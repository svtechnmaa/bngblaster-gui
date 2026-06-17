/** API service using Axios with JWT interceptor. */

import axios from 'axios';
import { useAuthStore } from '../store/useAuthStore';

const basePath = window.location.pathname.startsWith('/bngblaster-gui') ? '/bngblaster-gui' : '';

const api = axios.create({
    baseURL: `${basePath}/api/v1`,
    headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
    const token = useAuthStore.getState().token;
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
});

api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            useAuthStore.getState().logout();
            window.location.href = `${basePath}/login`;
        }
        return Promise.reject(error);
    },
);

export default api;
