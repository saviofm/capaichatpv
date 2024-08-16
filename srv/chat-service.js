const cds = require('@sap/cds');
const { DELETE } = cds.ql;
const { handleMemoryBeforeRagCall, handleMemoryAfterRagCall } = require('./memory-helper');

//userId = cds.env.requires["SUCCESS_FACTORS_CREDENTIALS"]["USER_ID"]

const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK'; 
const embeddingColumn  = 'EMBEDDING'; 
const contentColumn = 'TEXT_CHUNK';

const systemPrompt = 
`Sua tarefa é classificar a pergunta do usuário em uma das duas categorias: equipamento ou pergunta-generica\n

 Se o usuário quiser obter informações de equipamento, seja manual, roteiro de manutenção ou suporte, retorne a resposta como json com o seguinte formato:
 {
    "categoria" : "equipamento"
 } 

Para todas as outras consultas, retorne a resposta como json da seguinte forma
 {
    "categoria" : "pergunta-generica"
 } 

Regra:

1. Se o usuário não fornecer nenhuma informação do equipamento, considere-a como uma categoria genérica.
EXEMPLO:

EXEMPLO1: 

entrada do usuário: Qual a caracteristica do regulador de tensão ABC?
resposta:  {
    "categoria" : "equipamento"
  
} 


EXEMPLO2: 

entrada do usuáriot: Qual as sessões do evento XYZ ?
resposta:  {
    "categoria" : "pergunta-generica"
 } 


EXEMPLO3: 

entrada do usuáriot: Qual o plano de manutenção da aeronave ERX_XDF?
resposta:  {
    "categoria" : "equipamento"
 } 

EXEMPLO4: 

entrada do usuáriot: Qual a política para sair de férias?
resposta:  {
    "categoria" : "pergunta-generica"
 } 
`;

const equipRequestPrompt = 
`Você é um chatbot. Responda à pergunta do usuário com base nas seguintes informações
1. Responder sobre caracteristica  ou manutenção de equipamentos, delimitada por acentos graves triplos. \n
2. Se houver alguma diretriz específica referente ao roteiro de manutenção ou manual de equipamento a mesma deve ser descrita.\n

Regras: \n
1. Faça perguntas suplementares se precisar de informações adicionais do usuário para responder à pergunta.\n
2. Caso não possa dar uma resposta precisa, responda que é necessário carregar os manuais especifico do equipamento no sistema \n
3. Seja mais formal em sua resposta. \n
4. Mantenha as respostas concisas.`
;

const genericRequestPrompt = 
'Você é um chatbot. Responda à pergunta do usuário com base apenas no contexto, delimitado por acentos graves triplos\n ';
;

const taskCategory = {
    "equipamento" : equipRequestPrompt,
    "pergunta-generica" : genericRequestPrompt
}

function getFormattedDate (timeStamp)
{
    const timestamp = Number(timeStamp);
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'GMT',
      }).format(date);
}




module.exports = function () {

    this.on('getChatRagResponse', async (req) => {
        try {
            //request input data
            const { conversationId, messageId, message_time, user_id, user_query } = req.data;
            const { Conversation, Message } = this.entities;
            const vectorplugin = await cds.connect.to("cap-llm-plugin");


            let determinationPayload = [{
                "role" : "system",
                "content" : `${systemPrompt}`
              }];

            const userQuestion = [
                {
                  "role": "user",
                  "content": `${user_query}`
                }
              ]
            
            determinationPayload.push(...userQuestion);
            let payload = {
                "messages": determinationPayload
            };

            const determinationResponse = await vectorplugin.getChatCompletion(payload)
            const determinationJson = JSON.parse(determinationResponse.content);
            const categoria = determinationJson?.categoria ;

            if (! taskCategory.hasOwnProperty(categoria)) {
                throw new Error(`${categoria} is not in the supported`);
              }
            
            
            
            

            //handle memory before the RAG LLM call
            const memoryContext = await handleMemoryBeforeRagCall (conversationId , messageId, message_time, user_id , user_query, Conversation, Message );
            
            /*Single method to perform the following :
            - Embed the input query
            - Perform similarity search based on the user query 
            - Construct the prompt based on the system instruction and similarity search
            - Call chat completion model to retrieve relevant answer to the user query
            */

            const promptCategoria  = {
                "equipamento" : equipRequestPrompt,
                "pergunta-generica" : genericRequestPrompt
            }

            const chatRagResponse = await vectorplugin.getRagResponse(
                user_query,
                tableName,
                embeddingColumn,
                contentColumn,
                promptCategoria[categoria] ,
                memoryContext .length > 0 ? memoryContext : undefined,
                30
            );

            //handle memory after the RAG LLM call
            const responseTimestamp = new Date().toISOString();
            await handleMemoryAfterRagCall (conversationId , responseTimestamp, chatRagResponse.completion, Message, Conversation);

            const response = {
                "role" : chatRagResponse.completion.role,
                "content" : chatRagResponse.completion.content,
                "messageTime": responseTimestamp,
                "additionalContents": chatRagResponse.additionalContents,
            };

            return response;
        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Erro ao gerar resposta para consulta do usuário:', error);
            throw error;
        }

    })


    this.on('deleteChatData', async () => {
        try {
            const { Conversation, Message } = this.entities;
            await DELETE.from(Conversation);
            await DELETE.from(Message);
            return "Sucesso!"
        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Erro ao excluir o conteúdo do chat no banco de dados:', error);
            throw error;
        }
    })

}