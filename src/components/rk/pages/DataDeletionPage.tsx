"use client";

import { LegalPage, Bullets, Callout } from "./LegalPage";

export function DataDeletionPage() {
  return (
    <LegalPage
      title="Data Deletion Instructions"
      subtitle="How to request deletion of your personal data collected by RK Residency Vrindavan — through our website, bookings, contact forms or the Facebook platform."
      accent="teal"
      path="/data-deletion"
      effectiveDate="November 2026"
      intro={
        <>
          <p>
            RK Residency collects personal information only to manage your stay and
            communicate with you. If you want your data removed, you can request deletion
            at any time using any of the methods below. We process every deletion request
            promptly and confirm once it is done.
          </p>
        </>
      }
      sections={[
        {
          id: "how-to-request",
          number: "1",
          title: "How to Request Deletion",
          body: (
            <>
              <p>Choose whichever method is easiest for you:</p>
              <Bullets
                items={[
                  <>
                    <strong>Email:</strong> write to{" "}
                    <a href="mailto:rkresidency121@gmail.com" className="text-teal underline">
                      rkresidency121@gmail.com
                    </a>{" "}
                    with the subject <em>&ldquo;Data Deletion Request&rdquo;</em>. Mention your
                    name, phone number and booking reference code (if any).
                  </>,
                  <>
                    <strong>Phone / WhatsApp:</strong> call or message the front desk at{" "}
                    <strong>9760814931</strong> and ask for your data to be deleted.
                  </>,
                  <>
                    <strong>In person:</strong> ask at the front desk during your stay or visit.
                  </>,
                ]}
              />
              <p>
                We verify the requester's identity before deleting anything, to protect
                your account from unauthorised deletion requests.
              </p>
            </>
          ),
        },
        {
          id: "what-is-deleted",
          number: "2",
          title: "What Data Gets Deleted",
          body: (
            <>
              <p>On a confirmed deletion request we remove:</p>
              <Bullets
                items={[
                  "Your name, email address and mobile number",
                  "Booking history and reservation records linked to you",
                  "Contact-form messages and enquiry history",
                  "Newsletter subscription records",
                  "Discount coupon records issued to you",
                ]}
              />
            </>
          ),
        },
        {
          id: "deleting-facebook-data",
          number: "3",
          title: "Deleting Data Shared Through Facebook",
          body: (
            <>
              <p>
                Our website's Facebook integration is used by the hotel to publish its own
                page posts — guests never log in to this website using Facebook, so no
                guest Facebook profile data is stored here.
              </p>
              <p>
                If you have connected our app on Facebook (for example through Facebook
                Login on some other surface), you can revoke access and delete the shared
                data yourself:
              </p>
              <Bullets
                items={[
                  "Open Facebook → Settings & privacy → Settings",
                  "Go to Apps and websites",
                  "Select RK Residency Automation and click Remove",
                ]}
              />
              <Callout variant="note">
                Removing the app from your Facebook account deletes the data Facebook
                shared with the app. For anything stored by RK Residency directly, use the
                request methods in section 1.
              </Callout>
            </>
          ),
        },
        {
          id: "retention-exceptions",
          number: "4",
          title: "Records We Must Keep",
          body: (
            <>
              <p>
                Indian tax law requires us to retain invoices and payment records of
                completed stays for audit purposes. Those financial documents are kept in
                legally required form for the mandated period; everything else about you
                is deleted on request. We also never sell or share your personal data with
                third parties for marketing.
              </p>
            </>
          ),
        },
        {
          id: "timeline-contact",
          number: "5",
          title: "Timeline & Contact",
          body: (
            <>
              <p>
                Deletion requests are completed within 7 working days, and we send you a
                confirmation email once your data has been removed. Questions about this
                policy can go to{" "}
                <a href="mailto:rkresidency121@gmail.com" className="text-teal underline">
                  rkresidency121@gmail.com
                </a>
                .
              </p>
            </>
          ),
        },
      ]}
    />
  );
}
