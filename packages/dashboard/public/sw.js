self.addEventListener("push", (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.title === "string" ? payload.title : "Oneon";
  const body = typeof payload.body === "string" ? payload.body : "You have a new update.";
  const deepLink =
    typeof payload.deepLink === "string" && payload.deepLink.length > 0
      ? payload.deepLink
      : "/notifications";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { deepLink },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const deepLink =
    event.notification &&
    event.notification.data &&
    typeof event.notification.data.deepLink === "string"
      ? event.notification.data.deepLink
      : "/notifications";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            client.postMessage({ type: "push-click", deepLink });
            return client.focus();
          }
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(deepLink);
        }

        return undefined;
      }),
  );
});
