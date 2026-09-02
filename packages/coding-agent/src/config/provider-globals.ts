interface ProviderGlobalSettings {
	get(path: "providers.webSearchOrder"): unknown;
	get(path: "providers.webSearchExclude"): unknown;
	get(path: "providers.imageOrder"): unknown;
}

export async function applyProviderGlobalsFromSettings(settings: ProviderGlobalSettings): Promise<void> {
	const excludedWebSearchProviders = settings.get("providers.webSearchExclude");
	const orderedWebSearchProviders = settings.get("providers.webSearchOrder");
	const orderedImageProviders = settings.get("providers.imageOrder");

	if (Array.isArray(excludedWebSearchProviders) || Array.isArray(orderedWebSearchProviders)) {
		// Latency boundary: load webSearch only when search preferences are customized
		const webSearch = await import("../web/search");
		if (Array.isArray(excludedWebSearchProviders)) {
			webSearch.setExcludedSearchProviders(excludedWebSearchProviders.filter(webSearch.isSearchProviderId));
		}
		if (Array.isArray(orderedWebSearchProviders)) {
			webSearch.setSearchProviderOrder(orderedWebSearchProviders.filter(webSearch.isSearchProviderId));
		}
	}

	if (Array.isArray(orderedImageProviders)) {
		// Latency boundary: load imageGen only when image provider preferences are customized
		const { setImageProviderOrder } = await import("../tools/image-gen");
		setImageProviderOrder(orderedImageProviders.filter((entry): entry is string => typeof entry === "string"));
	}
}
