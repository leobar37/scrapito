import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  FreshnessResponseSchema,
  OfferHistoryResponseSchema,
  OfferSearchInputSchema,
  OfferSearchPageSchema,
  UpdatesPageSchema,
  encodeOfferSearchParams,
  ProductDetailSchema,
  type OfferSearchInput,
} from "@scrapito/contracts";
import { z } from "zod";
import { apiGet } from "../../../lib/api-client.ts";

const ProductDetailResponseSchema = z.object({ data: ProductDetailSchema });

function offersPath(input: OfferSearchInput, cursor?: string | null): string {
  const params = encodeOfferSearchParams(cursor ? { ...input, cursor } : input);
  return `/offers?${params.toString()}`;
}

export const offersInfiniteQueryOptions = (input: OfferSearchInput) =>
  infiniteQueryOptions({
    queryKey: ["offers", input],
    queryFn: async ({ pageParam }) => apiGet(offersPath(input, pageParam), OfferSearchPageSchema),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

export const productDetailQueryOptions = (productId: number) =>
  queryOptions({
    queryKey: ["product", productId],
    queryFn: async () => apiGet(`/products/${productId}`, ProductDetailResponseSchema),
  });

export const offerHistoryQueryOptions = (productId: number) =>
  queryOptions({
    queryKey: ["offer-history", productId],
    queryFn: async () => apiGet(`/offers/${productId}/history`, OfferHistoryResponseSchema),
  });

export const updatesQueryOptions = (store?: string) =>
  queryOptions({
    queryKey: ["updates", store ?? null],
    queryFn: async () => apiGet(`/updates${store ? `?store=${encodeURIComponent(store)}` : ""}`, UpdatesPageSchema),
  });

export const freshnessQueryOptions = () =>
  queryOptions({
    queryKey: ["freshness"],
    queryFn: async () => apiGet("/freshness", FreshnessResponseSchema),
  });

export { OfferSearchInputSchema };
