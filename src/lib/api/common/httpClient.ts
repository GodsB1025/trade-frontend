import axios, { type AxiosInstance, type AxiosError } from "axios";
import type {
  ApiResponse,
  ApiErrorCode,
  ApiErrorData,
} from "../../../types/common";
import { tokenStore } from "../../auth/tokenStore";

/**
 * 함수형 API 클라이언트 모듈
 * - Access Token: 메모리 저장 (tokenStore)
 * - Refresh Token: HttpOnly 쿠키 (자동 포함)
 * - 자동 토큰 갱신 및 재시도 지원
 */

let refreshing = false;
let refreshPromise: Promise<void> | null = null;
let authFailureHandled = false; // 인증 실패 처리 중복 방지

const instance: AxiosInstance = axios.create({
  baseURL: "http://localhost:8081/api",
  timeout: 30000,
  withCredentials: true, // HttpOnly 쿠키 자동 포함
});

// --- API 에러 처리를 위한 함수형 접근 ---

/**
 * API 에러 객체 타입 정의
 */
export type HttpClientError = Error & {
  statusCode: number;
  errorCode?: ApiErrorCode;
  isAuthError: boolean;
};

/**
 * 주어진 에러가 ApiError 타입인지 확인하는 타입 가드
 * @param error 확인할 에러
 * @returns 타입 일치 여부
 */
export const isHttpClientError = (error: unknown): error is HttpClientError => {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "isAuthError" in error
  );
};

/**
 * ApiError를 생성하는 팩토리 함수
 */
const createHttpClientError = (
  statusCode: number,
  errorCode?: ApiErrorCode,
  message?: string,
): HttpClientError => {
  const error = new Error(
    message || "API 요청 중 오류 발생",
  ) as HttpClientError;
  error.name = "HttpClientError";
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  error.isAuthError = statusCode === 401 || statusCode === 403;
  return error;
};

/**
 * 토큰 갱신 수행
 */
const performTokenRefresh = async (): Promise<void> => {
  try {
    if (import.meta.env.DEV) {
      console.log("🔄 자동 토큰 갱신 시작");
    }

    const refreshResponse = await axios.post<
      ApiResponse<{ accessToken: string }>
    >("http://localhost:8081/api/auth/refresh", undefined, {
      withCredentials: true, // HttpOnly 쿠키 포함
    });

    if (
      refreshResponse.data.success === "SUCCESS" &&
      refreshResponse.data.data?.accessToken
    ) {
      tokenStore.setToken(refreshResponse.data.data.accessToken);

      if (import.meta.env.DEV) {
        console.log("✅ 자동 토큰 갱신 성공");
      }
    } else {
      throw createHttpClientError(
        500,
        undefined,
        "토큰 갱신 응답이 올바르지 않습니다",
      );
    }
  } catch (refreshError) {
    if (import.meta.env.DEV) {
      console.warn("⚠️ 토큰 갱신 실패:", refreshError);
    }
    tokenStore.clearToken();
    throw refreshError;
  }
};

/**
 * 인증 실패 처리 (무한 새로고침 방지 개선)
 */
const handleAuthFailure = (): void => {
  if (authFailureHandled) {
    return;
  }
  authFailureHandled = true;
  tokenStore.clearToken();

  if (import.meta.env.DEV) {
    console.log("🚪 인증 실패 - 토큰 정리 완료");
  }

  if (typeof window !== "undefined") {
    const currentPath = window.location.pathname + window.location.search;
    if (currentPath !== "/auth/login" && !currentPath.startsWith("/auth/")) {
      sessionStorage.setItem("redirect_after_login", currentPath);
    }
    if (import.meta.env.DEV) {
      console.log("💡 인증 실패 처리 완료 - 라우터가 자동으로 리디렉션 처리");
    }
  }

  setTimeout(() => {
    authFailureHandled = false;
  }, 3000);
};

const extractData = <T>(apiResponse: ApiResponse<T>): T => {
  if (apiResponse.success === "ERROR") {
    throw createHttpClientError(
      500,
      undefined,
      apiResponse.message || "API 요청 실패",
    );
  }
  if (!apiResponse.data) {
    throw createHttpClientError(500, undefined, "응답 데이터 없음");
  }
  return apiResponse.data;
};

// 요청 인터셉터: Access Token 추가
instance.interceptors.request.use(
  (config) => {
    const token = tokenStore.getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    if (import.meta.env.DEV) {
      console.error("🔴 요청 인터셉터 오류:", error);
    }
    return Promise.reject(error);
  },
);

// 응답 인터셉터: 자동 토큰 갱신
instance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config;

    if (
      error.response?.status === 401 &&
      originalRequest &&
      !(originalRequest as any)._retry &&
      !refreshing
    ) {
      (originalRequest as any)._retry = true;

      try {
        if (!refreshPromise) {
          refreshing = true;
          refreshPromise = performTokenRefresh();
        }
        await refreshPromise;

        const newToken = tokenStore.getToken();
        if (newToken) {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return instance.request(originalRequest);
        }
      } catch (refreshError) {
        if (import.meta.env.DEV) {
          console.error("❌ 토큰 갱신 및 재시도 실패:", refreshError);
        }
        handleAuthFailure();
        throw refreshError;
      } finally {
        refreshing = false;
        refreshPromise = null;
      }
    }

    const errorData = error.response?.data as ApiErrorData | undefined;
    throw createHttpClientError(
      error.response?.status || 0,
      errorData?.errorCode,
      errorData?.message || error.message,
    );
  },
);

// 고차 함수를 사용한 메서드 팩토리
const createMethod =
  (method: "get" | "delete") =>
  <TResponse>(endpoint: string): Promise<TResponse> =>
    instance[method]<ApiResponse<TResponse>>(endpoint).then((res) =>
      extractData(res.data),
    );

const createMethodWithBody =
  (method: "post" | "put") =>
  <TResponse, TRequest = unknown>(
    endpoint: string,
    data?: TRequest,
  ): Promise<TResponse> =>
    instance[method]<ApiResponse<TResponse>>(endpoint, data).then((res) =>
      extractData(res.data),
    );

const createRawMethod =
  (method: "get" | "delete") =>
  <TResponse>(endpoint: string): Promise<ApiResponse<TResponse>> =>
    instance[method]<ApiResponse<TResponse>>(endpoint).then((res) => res.data);

const createRawMethodWithBody =
  (method: "post" | "put") =>
  <TResponse, TRequest = unknown>(
    endpoint: string,
    data?: TRequest,
  ): Promise<ApiResponse<TResponse>> =>
    instance[method]<ApiResponse<TResponse>>(endpoint, data).then(
      (res) => res.data,
    );

export const httpClient = {
  get: createMethod("get"),
  post: createMethodWithBody("post"),
  put: createMethodWithBody("put"),
  delete: createMethod("delete"),
};

export const rawHttpClient = {
  get: createRawMethod("get"),
  post: createRawMethodWithBody("post"),
  put: createRawMethodWithBody("put"),
  delete: createRawMethod("delete"),
};
