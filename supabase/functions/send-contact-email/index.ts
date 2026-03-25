import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

serve(async (req) => {
  // Handle CORS for browser
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  }

  try {
    const payload = await req.json()
    
    // Webhook from Supabase will send a 'record' object inside the payload
    const record = payload.record
    if (!record) {
      throw new Error("No record found in the webhook payload.")
    }

    const { name, phone, email, Description } = record

    // Pull your secure Resend API Key from the Deno Edge environment
    const resendApiKey = Deno.env.get('RESEND_API_KEY')
    
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not set in the Edge Function environment.")
    }

    // Call Resend's API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`
      },
      body: JSON.stringify({
        // Note: The 'from' email MUST be on a verified domain (like hotfuzzjam.com) to send via Resend!
        from: 'Website Contact Form <design@hotfuzzjam.com>', 
        to: ['design@hotfuzzjam.com'],
        subject: `New Contact Request: ${name}`,
        html: `
          <h2>New Contact Form Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Description:</strong></p>
          <p>${Description}</p>
        `
      })
    });

    const data = await res.json()
    
    return new Response(JSON.stringify(data), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
