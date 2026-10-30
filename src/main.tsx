import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installApiClient } from './apiClient';
import { ProductApp } from './product/ProductApp';
import './index.css';

// The engine console (the original demo screens) lives under /lab; everything else is the product.
const isLab = window.location.pathname === '/lab' || window.location.pathname.startsWith('/lab/');
if (isLab) installApiClient();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{isLab ? <App /> : <ProductApp />}</React.StrictMode>);
