"use client";

export type NotificationPermissionState = "unsupported" | "default" | "granted" | "denied";

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export function getNotificationPermissionState(): NotificationPermissionState {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

export function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register("/sw.js")
      .catch(() => null);
  }
  return swRegistrationPromise;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  await registerNotificationServiceWorker();
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return Notification.permission;
  }
}

export async function sendThreadNotification(params: {
  threadId: string;
  title: string;
  body: string;
  tag?: string;
  onSelectThread?: (threadId: string) => void;
}): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  if (Notification.permission !== "granted") {
    return false;
  }

  const options: NotificationOptions = {
    body: params.body,
    tag: params.tag ?? `thread:${params.threadId}`,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { threadId: params.threadId },
  };

  try {
    if ("serviceWorker" in navigator) {
      const reg =
        (await navigator.serviceWorker.getRegistration("/")) ??
        (await registerNotificationServiceWorker());
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(params.title, options);
        return true;
      }
    }
  } catch {
    // Fallback to window.Notification on desktop browsers without SW
  }

  try {
    const n = new Notification(params.title, options);
    n.onclick = () => {
      window.focus();
      params.onSelectThread?.(params.threadId);
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}
