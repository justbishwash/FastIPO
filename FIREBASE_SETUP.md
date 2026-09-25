# Firebase Cloud Vault Setup

1. Create or select a Firebase project.
2. Enable **Authentication > Sign-in method > Google**.
3. Create a **Cloud Firestore** database.
4. In Firestore Rules, publish the contents of `firestore.rules`.
5. Add the deployed Pages domain under **Authentication > Settings > Authorized domains**.
6. Register a Web app in Firebase Project settings.
7. Copy its web configuration into `public/firebase-config.js`.
8. Deploy the `public` folder again.

The app stores the AES-256-GCM encrypted vault and its generated encryption key in Firestore at `vaults/{Google user ID}`. Google authentication controls access to that document, so no master password is required. This protects the data at rest, but it is not zero-knowledge encryption because the key is stored with the encrypted vault.

The Firebase web configuration is safe to include in the frontend. Firestore Rules provide the access control; do not weaken them to allow public reads or writes.
