export const API_URL = "https://api.simkl.com";
export const CLIENT_ID = "a63b63d85af0e02d4cfc791d87c881f710693ecc86d280fc98f8618f8f1faaad";
export const CLIENT_SECRET = "9df1b7e078119eec54b694c216667be23f5a0c434aa7e7792e1ddbffb7d47336";
export const APP_NAME = "crunchflix";
export const APP_VERSION = "2.0.0";

export function getSimklUrl(endpoint) {
    const separator = endpoint.includes('?') ? '&' : '?';
    return `${API_URL}${endpoint}${separator}client_id=${CLIENT_ID}&app-name=${APP_NAME}&app-version=${APP_VERSION}`;
}

export function getSimklHeaders(token = null) {
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `${APP_NAME}/${APP_VERSION}`
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

