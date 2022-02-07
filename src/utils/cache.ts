export const CACHE = new WeakMap();
export const CACHE_NAME = 'EXTERNAL_FETCHES';
export const getRequest = async (url: RequestInfo, permanent: boolean = false) => {
    let request = new Request(url);
    let response: Response;

    // In specific situations the browser will sometimes disable access to cache storage, so, I create my own
    if ("caches" in globalThis) {
        let cache = await caches.open(CACHE_NAME);

        let cacheResponse = await cache.match(request);
        response = cacheResponse;

        if (permanent) {
            if (!cacheResponse) {
                let networkResponse = await fetch(request);
                cache.put(request, networkResponse.clone());
                response = networkResponse;
            }
        } else {
            let networkResponse = await fetch(request);
            cache.put(request, networkResponse.clone());
            response = cacheResponse || networkResponse;
        }
    } else {
        let cacheResponse = CACHE.get(request);
        let response = cacheResponse;

        if (permanent) {
            if (!cacheResponse) {
                let networkResponse = await fetch(request);
                CACHE.set(request, networkResponse.clone());
                response = networkResponse;
            }
        } else {
            let networkResponse = await fetch(request);
            CACHE.set(request, networkResponse.clone());
            response = cacheResponse || networkResponse;
        }
    }

    return response.clone();
}
