import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installApiClient } from './apiClient';
import { LegalWorkspace } from './components/legal/LegalWorkspace';
import { AssistantSettings } from './components/settings/AssistantSettings';
import { SharePage } from './components/share/SharePage';
import { ProductApp } from './product/ProductApp';
import './index.css';

installApiClient();

// /lab is the engine console (the original dashboard), /legal the lawyer's workspace, /settings
// connects coding assistants, /share/<token> is an auditor's read-only view (add ?view=product
// for the product-styled copy). Everything else is the product app.
const at = (prefix: string) => window.location.pathname === prefix || window.location.pathname.startsWith(`${prefix}/`);
const shareToken = window.location.pathname.match(/^\/share\/([^/]+)\/?$/)?.[1];
const productShare = new URLSearchParams(window.location.search).get('view') === 'product';
const page =
  shareToken && !productShare ? <SharePage token={decodeURIComponent(shareToken)} /> : at('/lab') ? <App /> : at('/legal') ? <LegalWorkspace /> : at('/settings') ? <AssistantSettings /> : <ProductApp />;

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{page}</React.StrictMode>);
