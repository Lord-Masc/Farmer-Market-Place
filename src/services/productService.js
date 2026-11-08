import { supabase } from './supabase';

export const productService = {
  // Fetch all products
  async getAllProducts() {
    const { data, error } = await supabase
      .from('products')
      .select('*');
    
    if (error) throw error;
    return data;
  },

  // Fetch products by category
  async getProductsByCategory(category) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('category', category);
    
    if (error) throw error;
    return data;
  },

  // Fetch a single product by ID
  async getProductById(id) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    return data;
  },

  // Add a new product (for farmers)
  async addProduct(product) {
    const { data, error } = await supabase
      .from('products')
      .insert([product]);
    
    if (error) throw error;
    return data;
  },

  // Update an existing product
  async updateProduct(id, updates) {
    const { data, error } = await supabase
      .from('products')
      .update(updates)
      .eq('id', id);
    
    if (error) throw error;
    return data;
  },

  // Delete a product (owner-scoped when the caller's farmer id is given)
  async deleteProduct(id, farmerId) {
    let query = supabase
      .from('products')
      .delete()
      .eq('id', id);

    if (farmerId) query = query.eq('farmer_id', farmerId);

    const { error } = await query;

    if (error) throw error;
  }
};
