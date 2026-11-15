import { DataDeletionPage } from "@/components/rk/pages/DataDeletionPage";
import type { Metadata } from "next";
import { absUrl, pageOpenGraph, pageTwitter } from "@/lib/seo";

const pageTitle = "Data Deletion Instructions — RK Residency Vrindavan";
const pageDescription = "How to request deletion of your personal data collected by RK Residency Vrindavan — via email, phone or in person.";

export const metadata: Metadata = {
  title: pageTitle,
  description: pageDescription,
  alternates: { canonical: absUrl("/data-deletion") },
  openGraph: pageOpenGraph({ path: "/data-deletion", title: pageTitle, description: pageDescription, image: "/images/hero-vrindavan.webp" }),
  twitter: pageTwitter({ title: pageTitle, description: pageDescription, image: "/images/hero-vrindavan.webp" }),
  robots: { index: true, follow: true },
};

export default function DataDeletionRoute() {
  return <DataDeletionPage />;
}
